package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// This process can see where you point and when you click. Which origins may
// drive it, and which interfaces it answers on, are the two things that keep
// that from being readable by anything other than Studio on this machine.

func TestAllowedOriginIsLocalhostOnly(t *testing.T) {
	for _, ok := range []string{
		"http://localhost:5273",  // dev server
		"http://localhost:8788",  // backend serving the built UI
		"http://127.0.0.1:8788",  //
		"https://localhost:5273", //
		"http://[::1]:5273",      //
	} {
		if !allowedOrigin(ok) {
			t.Errorf("allowedOrigin(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{
		"",
		"null",
		"http://evil.com",
		"https://studio.example.com",
		// The dangerous near-misses: hostnames that merely contain or resemble
		// localhost, and which a substring check would wave through.
		"http://localhost.evil.com",
		"http://notlocalhost",
		"http://127.0.0.1.evil.com",
		"http://0.0.0.0",
		"http://192.168.1.10",
	} {
		if allowedOrigin(bad) {
			t.Errorf("allowedOrigin(%q) = true, want false", bad)
		}
	}
}

func TestRefusesNonLoopbackBind(t *testing.T) {
	for _, ok := range []string{"127.0.0.1:8791", "localhost:8791", "[::1]:8791"} {
		if err := warnIfNotLoopback(ok); err != nil {
			t.Errorf("warnIfNotLoopback(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{":8791", "0.0.0.0:8791", "192.168.1.10:8791"} {
		if err := warnIfNotLoopback(bad); err == nil {
			t.Errorf("warnIfNotLoopback(%q) = nil, want a refusal", bad)
		}
	}
}

// fakePointer swaps in a scripted pointer for the duration of a test.
func fakePointer(t *testing.T, pos func(i int) (int, int), btn func(i int) uint8) *int64 {
	t.Helper()
	var calls int64
	oc, ob, os := readCursor, readButtons, readScreen
	readCursor = func() (int, int) {
		i := int(atomic.AddInt64(&calls, 1)) - 1
		return pos(i)
	}
	readButtons = func() uint8 {
		if btn == nil {
			return 0
		}
		return btn(int(atomic.LoadInt64(&calls)) - 1)
	}
	readScreen = func() (int, int) { return 1920, 1080 }
	t.Cleanup(func() { readCursor, readButtons, readScreen = oc, ob, os })
	return &calls
}

// A tutorial is mostly a motionless pointer. Recording every poll would make
// the sidecar enormous while saying nothing, so a still pointer must collapse
// to the heartbeat rate.
func TestStillPointerCollapsesToHeartbeat(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 500, 500 }, nil)

	var tr Tracker
	tr.Start()
	time.Sleep(600 * time.Millisecond)
	rec := tr.Stop()

	// 600ms at 60Hz is ~36 polls; the heartbeat should let through ~3.
	if n := len(rec.Samples); n < 1 || n > 8 {
		t.Errorf("still pointer produced %d samples in 600ms, want a heartbeat trickle (~3)", n)
	}
	for _, s := range rec.Samples {
		if s.X != 500 || s.Y != 500 {
			t.Fatalf("unexpected position %v", s)
		}
	}
}

// The heartbeat exists so a consumer can tell "parked here" from "no data".
func TestHeartbeatBoundsTheGap(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 10, 10 }, nil)

	var tr Tracker
	tr.Start()
	time.Sleep(900 * time.Millisecond)
	rec := tr.Stop()

	if len(rec.Samples) < 2 {
		t.Fatalf("want at least two samples, got %d", len(rec.Samples))
	}
	for i := 1; i < len(rec.Samples); i++ {
		if gap := rec.Samples[i].T - rec.Samples[i-1].T; gap > int64(heartbeat/time.Millisecond)+50 {
			t.Errorf("gap of %dms exceeds the %v heartbeat", gap, heartbeat)
		}
	}
}

// Motion is the signal; none of it may be dropped.
func TestMovementIsRecordedEveryPoll(t *testing.T) {
	fakePointer(t, func(i int) (int, int) { return i, i * 2 }, nil)

	var tr Tracker
	tr.Start()
	time.Sleep(400 * time.Millisecond)
	rec := tr.Stop()

	// ~24 polls in 400ms, every one of them a new position.
	if n := len(rec.Samples); n < 10 {
		t.Fatalf("moving pointer produced only %d samples", n)
	}
	for i := 1; i < len(rec.Samples); i++ {
		if rec.Samples[i].X <= rec.Samples[i-1].X {
			t.Fatalf("samples out of order or deduped: %v then %v", rec.Samples[i-1], rec.Samples[i])
		}
		if rec.Samples[i].Y != rec.Samples[i].X*2 {
			t.Fatalf("x/y desynchronised: %v", rec.Samples[i])
		}
	}
}

// A click on a motionless pointer is the case dedup could most easily eat, and
// it is precisely the event cursor effects are built to emphasise.
func TestClickOnAStillPointerIsNotDeduped(t *testing.T) {
	var down atomic.Bool
	fakePointer(t,
		func(int) (int, int) { return 300, 300 },
		func(int) uint8 {
			if down.Load() {
				return ButtonLeft
			}
			return 0
		})

	var tr Tracker
	tr.Start()
	time.Sleep(100 * time.Millisecond)
	down.Store(true)
	time.Sleep(60 * time.Millisecond)
	down.Store(false)
	time.Sleep(100 * time.Millisecond)
	rec := tr.Stop()

	var sawDown, sawUpAfter bool
	for _, s := range rec.Samples {
		if s.Down&ButtonLeft != 0 {
			sawDown = true
		} else if sawDown {
			sawUpAfter = true
		}
	}
	if !sawDown {
		t.Error("the click was never recorded")
	}
	if !sawUpAfter {
		t.Error("the release was never recorded")
	}
}

func TestRestartDiscardsThePreviousSession(t *testing.T) {
	fakePointer(t, func(i int) (int, int) { return i, i }, nil)

	var tr Tracker
	tr.Start()
	time.Sleep(200 * time.Millisecond)
	if !tr.Running() {
		t.Fatal("tracker should report running")
	}
	// A reloaded tab starts again without stopping; that must not accumulate.
	second := tr.Start()
	time.Sleep(80 * time.Millisecond)
	rec := tr.Stop()

	if tr.Running() {
		t.Error("tracker should report stopped")
	}
	if rec.StartedAt != second.StartedAt {
		t.Error("restart should have reset the session start")
	}
	if len(rec.Samples) > 40 {
		t.Errorf("second session carried %d samples — the first was not discarded", len(rec.Samples))
	}
	if rec.Screen.Width != 1920 || rec.Screen.Height != 1080 {
		t.Errorf("screen not captured: %+v", rec.Screen)
	}
}

func TestStopWithoutStartIsHarmless(t *testing.T) {
	var tr Tracker
	if rec := tr.Stop(); len(rec.Samples) != 0 {
		t.Errorf("stop before start returned %d samples", len(rec.Samples))
	}
}
