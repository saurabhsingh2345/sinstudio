// Package jobs is an in-process job registry with a Server-Sent-Events fan-out.
// Every long-running action (clip generation, transcription, export) is a Job;
// its progress is pushed to all subscribed browser clients over SSE. SSE keeps
// v1 dependency-free (pure stdlib) while giving live server->client progress.
package jobs

import (
	"encoding/json"
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
	Progress float64 `json:"progress"` // 0..1
	Message  string  `json:"message,omitempty"`
	Data     any     `json:"data,omitempty"` // payload on done (e.g. the new asset)
	At       string  `json:"at"`
}

// Job is a tracked unit of work.
type Job struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Status  string  `json:"status"` // running|done|error
	Pct     float64 `json:"progress"`
	Message string  `json:"message"`
	m       *Manager
}

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

// New creates and registers a running job.
func (m *Manager) New(kind string) *Job {
	j := &Job{ID: store.NewID("job_"), Kind: kind, Status: "running", m: m}
	m.mu.Lock()
	m.jobs[j.ID] = j
	m.mu.Unlock()
	return j
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

// Progress reports fractional progress with a message.
func (j *Job) Progress(p float64, msg string) {
	j.Pct, j.Message = p, msg
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventProgress, Progress: p, Message: msg})
}

// Log emits a log line without changing progress.
func (j *Job) Log(msg string) {
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventLog, Progress: j.Pct, Message: msg})
}

// Done marks the job complete and attaches an optional result payload.
func (j *Job) Done(data any) {
	j.Status, j.Pct = "done", 1
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventDone, Progress: 1, Data: data})
}

// Fail marks the job errored.
func (j *Job) Fail(err error) {
	j.Status = "error"
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	j.Message = msg
	j.m.broadcast(Event{JobID: j.ID, Kind: j.Kind, Type: EventError, Progress: j.Pct, Message: msg})
}

// Encode is a helper for SSE writers to serialize an event as JSON.
func Encode(ev Event) []byte {
	b, _ := json.Marshal(ev)
	return b
}
