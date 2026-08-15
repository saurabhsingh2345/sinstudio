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
	// K is which system cursor was showing — see kind_darwin.go for the codes.
	// Absent (0) means "not known", which every consumer treats as the default
	// arrow rather than as a shape in its own right.
	K uint8 `json:"k,omitempty"`
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
	// Kinds reports whether cursor SHAPES could be read, for the same reason
	// Clicks exists: a stream of zeros is indistinguishable from "the pointer
	// was an arrow the whole time", and those are very different claims.
	Kinds bool `json:"kinds"`
	// Clicks reports whether button state could actually be read. Positions are
	// useful on their own, so a platform that can't see buttons still records —
	// it says so rather than silently emitting a stream of zeros that looks
	// exactly like "the user never clicked".
	Clicks bool `json:"clicks"`
	// Surface is what the consumer said it was capturing, attached after
	// tracking began: the share does not exist until the user has picked one,
	// and the picker is slow, so waiting for it before sampling would lose the
	// pointer's position at frame zero.
	Surface *Surface `json:"surface,omitempty"`
	// Bounds is where that surface was, over time. Absent when no surface was
	// attached, and the consumer then falls back to treating the samples as
	// whole-screen coordinates — which is exactly what they were before any of
	// this existed.
	Bounds []BoundsSample `json:"bounds,omitempty"`
}

// sampleHz is the polling rate. 60 matches the fastest frame rate we offer, so
// no frame of the recording lacks a pointer sample near it.
const sampleHz = 60

// heartbeat bounds the gap between samples while the pointer is still. Without
// one, a cursor parked for a minute produces two samples a minute apart and any
// consumer interpolating between them has no way to know it was stationary the
// whole time rather than drifting slowly.
const heartbeat = 250 * time.Millisecond

// kindHz is how often the cursor's shape is re-read. A shape change follows the
// pointer crossing into a different control, which is a hand movement — 10Hz is
// already finer than that, and the read costs an image render and a hash, so it
// is not one to do sixty times a second.
const kindHz = 10

// boundsHz is how often the tracked surface's rectangle is re-read. A window
// is moved by a hand, not by a program, so 15Hz is already finer than anything
// a person can do to it — and unlike the pointer read, this one crosses into
// the window server, so it is the sample worth being frugal with.
const boundsHz = 15

// Indirection so the sampling loop can be exercised without a real pointer.
// The platform files supply the real readers.
var (
	readCursor  = cursorPos
	readButtons = buttons
	readScreen  = screenSize
	readRect    = lookupRect
	readList    = listSurfaces
	readKind    = cursorKind
)

// Tracker owns the sampling loop and the session buffer.
type Tracker struct {
	mu      sync.Mutex
	running bool
	stop    chan struct{}
	done    chan struct{}
	rec     Recording
	// surfaceID is read by the sampling loop every few ticks. Held under the
	// same lock as rec because attaching is a request that arrives mid-session,
	// from a different goroutine than the one sampling.
	surfaceID string
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
		Kinds:     kindsSupported(),
	}
	tr.surfaceID = ""
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
	out.Bounds = append([]BoundsSample(nil), tr.rec.Bounds...)
	return out
}

/*
Attach names the surface being captured, mid-session.

It has to be mid-session. The rectangle only becomes knowable once the user has
chosen something in the browser's share picker, and tracking must already be
running by then or the pointer's position at frame zero is a guess. So the
sequence is: start sampling, let the picker happen, then say what was picked.

The first rectangle is written immediately rather than waiting for the sampling
loop's next bounds tick, so a recording is never left with samples that precede
every bound it could be placed against.
*/
func (tr *Tracker) Attach(id string) (Surface, bool) {
	list := readList()
	s, ok := findSurface(list, id)
	if !ok {
		return Surface{}, false
	}
	rect, live := readRect(id)
	if !live {
		rect = s.Rect
	}

	tr.mu.Lock()
	defer tr.mu.Unlock()
	if !tr.running {
		return Surface{}, false
	}
	tr.surfaceID = id
	s.Rect = rect
	tr.rec.Surface = &s
	tr.rec.Bounds = append(tr.rec.Bounds[:0], BoundsSample{
		T: time.Now().UnixMilli(), X: rect.X, Y: rect.Y, W: rect.W, H: rect.H,
	})
	return s, true
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
	var kind uint8
	ticks := 0
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			ticks++
			if ticks%(sampleHz/boundsHz) == 0 {
				tr.sampleBounds()
			}
			// The shape is read on its own slower beat and stamped onto every
			// sample in between. Reading it per sample would mean sixty image
			// renders a second to answer a question that changes at the speed of
			// a hand.
			if ticks%(sampleHz/kindHz) == 0 {
				kind = readKind()
			}
			x, y := readCursor()
			s := Sample{T: time.Now().UnixMilli(), X: x, Y: y, Down: readButtons(), K: kind}
			// Drop samples that say nothing new. A still pointer would otherwise
			// write 60 identical rows a second, and a long tutorial is mostly a
			// still pointer — this is the difference between a ~100KB sidecar and
			// a multi-megabyte one, with no loss: the gaps are exactly the spans
			// where nothing changed.
			if have && s.X == last.X && s.Y == last.Y && s.Down == last.Down && s.K == last.K &&
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

/*
sampleBounds records where the tracked surface is now, if it has moved.

Deduplicated exactly like pointer samples, and for the same reason: a window
that sits still for ten minutes is the normal case, and it should cost two rows
rather than nine thousand. The heartbeat is deliberately absent here — a gap in
this series means "unchanged", and unlike a pointer there is no interpolation to
mislead, because a consumer reads the last bound at or before a sample's time
rather than blending between two.

A rectangle that cannot be read at all (the window was closed mid-take) is
skipped rather than recorded as zero. The last known position is a far better
answer than an origin at the corner of the screen, and holding it is what the
consumer does with a gap anyway.
*/
func (tr *Tracker) sampleBounds() {
	tr.mu.Lock()
	id := tr.surfaceID
	tr.mu.Unlock()
	if id == "" {
		return
	}
	rect, ok := readRect(id)
	if !ok || !rect.valid() {
		return
	}

	tr.mu.Lock()
	defer tr.mu.Unlock()
	if n := len(tr.rec.Bounds); n > 0 && tr.rec.Bounds[n-1].sameRect(rect) {
		return
	}
	tr.rec.Bounds = append(tr.rec.Bounds, BoundsSample{
		T: time.Now().UnixMilli(), X: rect.X, Y: rect.Y, W: rect.W, H: rect.H,
	})
}
