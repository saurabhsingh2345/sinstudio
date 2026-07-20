// Package jobs is an in-process job registry with a Server-Sent-Events fan-out.
// Every long-running action (clip generation, transcription, export) is a Job;
// its progress is pushed to all subscribed browser clients over SSE. SSE keeps
// v1 dependency-free (pure stdlib) while giving live server->client progress.
package jobs

import (
	"context"
	"encoding/json"
	"sort"
	"sync"
	"time"

	"studio/internal/store"
)

// Event types.
const (
	EventProgress = "progress"
	EventLog      = "log"
	EventDone     = "done"
	EventError    = "error"
)

// Event is one SSE message about a job.
type Event struct {
	JobID    string  `json:"jobId"`
	Kind     string  `json:"kind"`     // generate|transcribe|export|import
	Type     string  `json:"type"`     // progress|log|done|error
	Status   string  `json:"status"`   // queued|running|done|error|canceled
	Progress float64 `json:"progress"` // 0..1
	Message  string  `json:"message,omitempty"`
	Data     any     `json:"data,omitempty"` // payload on done (e.g. the new asset)
	At       string  `json:"at"`
}

// Job is a tracked unit of work.
type Job struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Status  string  `json:"status"` // running|done|error|canceled
	Pct     float64 `json:"progress"`
	Message string  `json:"message"`
	m       *Manager
	ctx     context.Context
	cancel  context.CancelFunc
	ended   time.Time // set on the terminal transition; zero while live
}

// Retention of finished jobs. Live jobs are never evicted. Finished ones stay
// long enough for a reconnecting client to poll their terminal state, then are
// dropped so a long-running server's registry doesn't grow without bound.
const (
	terminalCap = 200
	retainFor   = time.Hour
)

func isTerminal(status string) bool {
	return status == "done" || status == "error" || status == "canceled"
}

// Context returns the job's context. Worker subprocesses should run under it so
// the job can be canceled (by the client or on shutdown) or time out.
func (j *Job) Context() context.Context { return j.ctx }

// Manager tracks jobs and broadcasts events to SSE subscribers.
type Manager struct {
	mu   sync.Mutex
	subs map[chan Event]struct{}
	jobs map[string]*Job
}

// NewManager returns an empty job manager.
func NewManager() *Manager {
	return &Manager{subs: map[chan Event]struct{}{}, jobs: map[string]*Job{}}
}

// Subscribe registers an SSE client. The returned cancel func unsubscribes.
func (m *Manager) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 64)
	m.mu.Lock()
	m.subs[ch] = struct{}{}
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		if _, ok := m.subs[ch]; ok {
			delete(m.subs, ch)
			close(ch)
		}
		m.mu.Unlock()
	}
}

func (m *Manager) broadcast(ev Event) {
	ev.At = time.Now().UTC().Format(time.RFC3339)
	m.mu.Lock()
	defer m.mu.Unlock()
	for ch := range m.subs {
		select {
		case ch <- ev:
		default: // drop for slow clients rather than block the worker
		}
	}
}

// New creates and registers a running job. If timeout > 0 the job's context is
// canceled after that deadline, killing a hung subprocess; timeout <= 0 makes it
// cancelable but unbounded.
func (m *Manager) New(kind string, timeout time.Duration) *Job {
	return m.new(kind, timeout, "running")
}

// NewQueued registers a job in the "queued" state (waiting for a worker slot).
// Call Begin when it actually starts.
func (m *Manager) NewQueued(kind string, timeout time.Duration) *Job {
	j := m.new(kind, timeout, "queued")
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventProgress, Status: "queued", Message: "queued"})
	return j
}

func (m *Manager) new(kind string, timeout time.Duration, status string) *Job {
	var ctx context.Context
	var cancel context.CancelFunc
	if timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), timeout)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	j := &Job{ID: store.NewID("job_"), Kind: kind, Status: status, m: m, ctx: ctx, cancel: cancel}
	m.mu.Lock()
	m.jobs[j.ID] = j
	m.mu.Unlock()
	return j
}

// Begin transitions a queued job to running and announces it.
func (j *Job) Begin() {
	j.m.mu.Lock()
	j.Status = "running"
	j.m.mu.Unlock()
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventProgress, Status: "running", Progress: 0, Message: "started"})
}

// status reads the job's current status under the manager lock.
func (j *Job) status() string {
	j.m.mu.Lock()
	defer j.m.mu.Unlock()
	return j.Status
}

// List returns a snapshot of all jobs.
func (m *Manager) List() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Job, 0, len(m.jobs))
	for _, j := range m.jobs {
		out = append(out, *j)
	}
	return out
}

// Get returns a snapshot of one job so a reconnecting client can recover its
// state even if it missed the terminal SSE event.
func (m *Manager) Get(id string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return Job{}, false
	}
	return *j, true
}

// reapLocked evicts finished jobs past the retention window or the cap (newest
// kept first). The caller must hold m.mu.
func (m *Manager) reapLocked() {
	cutoff := time.Now().Add(-retainFor)
	finished := make([]*Job, 0, len(m.jobs))
	for id, j := range m.jobs {
		if !isTerminal(j.Status) {
			continue
		}
		if j.ended.Before(cutoff) {
			delete(m.jobs, id)
			continue
		}
		finished = append(finished, j)
	}
	if len(finished) <= terminalCap {
		return
	}
	sort.Slice(finished, func(a, b int) bool { return finished[a].ended.After(finished[b].ended) })
	for _, j := range finished[terminalCap:] {
		delete(m.jobs, j.ID)
	}
}

// Cancel requests cancellation of a running job (kills its subprocess). Returns
// false if the id is unknown.
func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	j, ok := m.jobs[id]
	m.mu.Unlock()
	if !ok {
		return false
	}
	j.cancel()
	return true
}

// CancelAll cancels every job — used on graceful shutdown so no subprocess is
// orphaned.
func (m *Manager) CancelAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		j.cancel()
	}
}

// Progress reports fractional progress with a message. Field writes are guarded
// by the manager lock so List()'s snapshot reads never race with a worker.
func (j *Job) Progress(p float64, msg string) {
	j.m.mu.Lock()
	j.Pct, j.Message = p, msg
	st := j.Status
	j.m.mu.Unlock()
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventProgress, Status: st, Progress: p, Message: msg})
}

// Log emits a log line without changing progress.
func (j *Job) Log(msg string) {
	j.m.mu.Lock()
	pct := j.Pct
	st := j.Status
	j.m.mu.Unlock()
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventLog, Status: st, Progress: pct, Message: msg})
}

// Done marks the job complete and attaches an optional result payload.
func (j *Job) Done(data any) {
	if j.cancel != nil {
		j.cancel() // release context resources
	}
	j.m.mu.Lock()
	j.Status, j.Pct, j.ended = "done", 1, time.Now()
	j.m.reapLocked()
	j.m.mu.Unlock()
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventDone, Status: "done", Progress: 1, Data: data})
}

// Fail marks the job errored (or canceled/timed-out, distinguished from the
// job context so the UI can label it correctly).
func (j *Job) Fail(err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	status := "error"
	if j.ctx != nil {
		switch j.ctx.Err() {
		case context.Canceled:
			status, msg = "canceled", "canceled"
		case context.DeadlineExceeded:
			status, msg = "error", "timed out"
		}
	}
	if j.cancel != nil {
		j.cancel()
	}
	j.m.mu.Lock()
	j.Status = status
	j.Message = msg
	j.ended = time.Now()
	pct := j.Pct
	j.m.reapLocked()
	j.m.mu.Unlock()
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventError, Status: status, Progress: pct, Message: msg})
}

// Encode is a helper for SSE writers to serialize an event as JSON.
func Encode(ev Event) []byte {
	b, _ := json.Marshal(ev)
	return b
}
