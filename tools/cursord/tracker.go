package main

import (
	"sync"
	"time"
)

// Button bits in Sample.Down. A bitmask rather than separate fields because the
// overwhelmingly common value is 0, and this keeps it off the wire entirely.
const (
	ButtonLeft  = 1 << 0
	ButtonRight = 1 << 1
)

// Sample is one observation of the pointer.
//
// T is epoch milliseconds, deliberately absolute rather than relative to the
// session. The consumer aligns these against the moment its MediaRecorder
// actually started, which it cannot tell us in advance and which does not
// coincide with when tracking began. Both clocks are the same machine's, so
// subtraction is exact.
type Sample struct {
	T    int64 `json:"t"`
	X    int   `json:"x"`
	Y    int   `json:"y"`
	Down uint8 `json:"down,omitempty"`
}

// Screen is the display the coordinates are expressed in. Sent with every
// session so the consumer can scale into video space without assuming the
// recording was made at native resolution.
type Screen struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Recording is the payload handed back when tracking stops.
type Recording struct {
	Version   int      `json:"version"`
	StartedAt int64    `json:"startedAt"`
	StoppedAt int64    `json:"stoppedAt"`
	Screen    Screen   `json:"screen"`
	Samples   []Sample `json:"samples"`
	// Clicks reports whether button state could actually be read. Positions are
	// useful on their own, so a platform that can't see buttons still records —
	// it says so rather than silently emitting a stream of zeros that looks
	// exactly like "the user never clicked".
	Clicks bool `json:"clicks"`
}

// sampleHz is the polling rate. 60 matches the fastest frame rate we offer, so
// no frame of the recording lacks a pointer sample near it.
const sampleHz = 60

// heartbeat bounds the gap between samples while the pointer is still. Without
// one, a cursor parked for a minute produces two samples a minute apart and any
// consumer interpolating between them has no way to know it was stationary the
// whole time rather than drifting slowly.
const heartbeat = 250 * time.Millisecond

// Indirection so the sampling loop can be exercised without a real pointer.
// The platform files supply the real readers.
var (
	readCursor  = cursorPos
	readButtons = buttons
	readScreen  = screenSize
)

// Tracker owns the sampling loop and the session buffer.
type Tracker struct {
	mu      sync.Mutex
	running bool
	stop    chan struct{}
	done    chan struct{}
	rec     Recording
}

func (tr *Tracker) Running() bool {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return tr.running
}

// Start begins sampling, discarding any previous session. Starting twice is not
// an error: the caller is a browser tab that may have been reloaded mid-session,
// and refusing would leave it permanently unable to record.
func (tr *Tracker) Start() Recording {
	tr.stopAndWait()

	w, h := readScreen()
	now := time.Now().UnixMilli()

	tr.mu.Lock()
	tr.rec = Recording{
		Version:   1,
		StartedAt: now,
		Screen:    Screen{Width: w, Height: h},
		Samples:   make([]Sample, 0, 4096),
		Clicks:    buttonsSupported(),
	}
	tr.running = true
	tr.stop = make(chan struct{})
	tr.done = make(chan struct{})
	stop, done := tr.stop, tr.done
	tr.mu.Unlock()

	go tr.loop(stop, done)

	tr.mu.Lock()
	defer tr.mu.Unlock()
	return tr.summary()
}

// Stop ends sampling and returns everything collected.
func (tr *Tracker) Stop() Recording {
	tr.stopAndWait()
	tr.mu.Lock()
	defer tr.mu.Unlock()
	tr.rec.StoppedAt = time.Now().UnixMilli()
	out := tr.rec
	out.Samples = append([]Sample(nil), tr.rec.Samples...)
	return out
}

func (tr *Tracker) stopAndWait() {
	tr.mu.Lock()
	if !tr.running {
		tr.mu.Unlock()
		return
	}
	tr.running = false
	close(tr.stop)
	done := tr.done
	tr.mu.Unlock()
	<-done // the loop owns rec while running; wait before touching it
}

// summary is the session without its samples, for the start/health replies.
// Caller holds the lock.
func (tr *Tracker) summary() Recording {
	out := tr.rec
	out.Samples = nil
	return out
}

func (tr *Tracker) loop(stop <-chan struct{}, done chan<- struct{}) {
	defer close(done)
	tick := time.NewTicker(time.Second / sampleHz)
	defer tick.Stop()

	var last Sample
	var have bool
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			x, y := readCursor()
			s := Sample{T: time.Now().UnixMilli(), X: x, Y: y, Down: readButtons()}
			// Drop samples that say nothing new. A still pointer would otherwise
			// write 60 identical rows a second, and a long tutorial is mostly a
			// still pointer — this is the difference between a ~100KB sidecar and
			// a multi-megabyte one, with no loss: the gaps are exactly the spans
			// where nothing changed.
			if have && s.X == last.X && s.Y == last.Y && s.Down == last.Down &&
				time.Duration(s.T-last.T)*time.Millisecond < heartbeat {
				continue
			}
			tr.mu.Lock()
			tr.rec.Samples = append(tr.rec.Samples, s)
			tr.mu.Unlock()
			last, have = s, true
		}
	}
}
