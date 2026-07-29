package main

import (
	"sync/atomic"
	"testing"
	"time"
)

// fakeSurfaces swaps in a scripted set of capturable rectangles. `rect` is
// consulted per read, so a test can move the window mid-session — which is the
// whole reason bounds are a series rather than a single measurement.
func fakeSurfaces(t *testing.T, list []Surface, rect func(id string) (Rect, bool)) {
	t.Helper()
	ol, or := readList, readRect
	readList = func() []Surface { return list }
	readRect = rect
	t.Cleanup(func() { readList, readRect = ol, or })
}

func TestParseSurfaceID(t *testing.T) {
	for _, ok := range []struct {
		in   string
		kind string
		num  int
	}{
		{"display:1", "display", 1},
		{"window:11800", "window", 11800},
	} {
		k, n, valid := parseSurfaceID(ok.in)
		if !valid || k != ok.kind || n != ok.num {
			t.Errorf("parseSurfaceID(%q) = %q,%d,%v", ok.in, k, n, valid)
		}
	}
	// Everything a page could send that isn't one of ours. The platform layer
	// takes an integer straight from here, so this is the boundary check.
	for _, bad := range []string{"", "window", "window:", "window:abc", "screen:1", ":1", "../etc/passwd", "display:1:2"} {
		if _, _, valid := parseSurfaceID(bad); valid {
			t.Errorf("parseSurfaceID(%q) accepted", bad)
		}
	}
}

// Attaching is what turns a window share into a mappable recording. Without a
// surface the session must still be usable — that is the whole-screen path
// every recording took before this existed.
func TestAttachRecordsTheSurfaceAndItsFirstBounds(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 500, 500 }, nil)
	win := Surface{ID: "window:7", Kind: "window", App: "Terminal", Rect: Rect{X: 100, Y: 200, W: 800, H: 600}}
	fakeSurfaces(t, []Surface{win}, func(string) (Rect, bool) { return Rect{X: 100, Y: 200, W: 800, H: 600}, true })

	var tr Tracker
	tr.Start()
	got, ok := tr.Attach("window:7")
	if !ok {
		t.Fatal("Attach refused a surface that exists")
	}
	if got.App != "Terminal" {
		t.Errorf("Attach returned %+v, want the enumerated window", got)
	}
	rec := tr.Stop()

	if rec.Surface == nil || rec.Surface.ID != "window:7" {
		t.Fatalf("recording did not carry the surface: %+v", rec.Surface)
	}
	// The first bound must exist immediately, not at the next bounds tick: a
	// sample with no bound at or before it has nowhere to be placed.
	if len(rec.Bounds) == 0 {
		t.Fatal("no bounds recorded")
	}
	if b := rec.Bounds[0]; b.X != 100 || b.Y != 200 || b.W != 800 || b.H != 600 {
		t.Errorf("first bound = %+v, want the window's rectangle", b)
	}
}

// Attaching something that is not in the enumeration must fail loudly. Accepting
// it would produce a session that claims to be mapped and has no rectangle to
// map through, which downstream reads as "place everything at the origin".
func TestAttachRejectsUnknownSurface(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 1, 1 }, nil)
	fakeSurfaces(t, []Surface{{ID: "display:1", Kind: "display", Rect: Rect{W: 1728, H: 1117}}}, func(string) (Rect, bool) {
		return Rect{}, false
	})

	var tr Tracker
	tr.Start()
	defer tr.Stop()
	if _, ok := tr.Attach("window:404"); ok {
		t.Error("Attach accepted a surface that does not exist")
	}
}

// A window is dragged mid-recording. The pointer's screen coordinates stay
// meaningful only if the rectangle they are measured against moves with it.
func TestBoundsFollowAMovingWindow(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 400, 400 }, nil)
	var moved atomic.Bool
	fakeSurfaces(t,
		[]Surface{{ID: "window:7", Kind: "window", Rect: Rect{X: 0, Y: 0, W: 800, H: 600}}},
		func(string) (Rect, bool) {
			if moved.Load() {
				return Rect{X: 300, Y: 120, W: 800, H: 600}, true
			}
			return Rect{X: 0, Y: 0, W: 800, H: 600}, true
		})

	var tr Tracker
	tr.Start()
	tr.Attach("window:7")
	time.Sleep(250 * time.Millisecond)
	moved.Store(true)
	time.Sleep(250 * time.Millisecond)
	rec := tr.Stop()

	if len(rec.Bounds) < 2 {
		t.Fatalf("the move was never recorded: %+v", rec.Bounds)
	}
	last := rec.Bounds[len(rec.Bounds)-1]
	if last.X != 300 || last.Y != 120 {
		t.Errorf("last bound = %+v, want the window's new position", last)
	}
	// And a window that sat still for a quarter of a second must not have
	// written a row per tick to say so.
	if len(rec.Bounds) > 6 {
		t.Errorf("%d bounds for one move — a still window is not being deduped", len(rec.Bounds))
	}
}

// A window closed mid-take stops answering. Holding its last known rectangle is
// right; writing a zero one would teleport every effect to the screen's corner.
func TestUnreadableBoundsAreSkippedNotZeroed(t *testing.T) {
	fakePointer(t, func(int) (int, int) { return 1, 1 }, nil)
	var gone atomic.Bool
	fakeSurfaces(t,
		[]Surface{{ID: "window:7", Kind: "window", Rect: Rect{X: 10, Y: 20, W: 400, H: 300}}},
		func(string) (Rect, bool) {
			if gone.Load() {
				return Rect{}, false
			}
			return Rect{X: 10, Y: 20, W: 400, H: 300}, true
		})

	var tr Tracker
	tr.Start()
	tr.Attach("window:7")
	gone.Store(true)
	time.Sleep(250 * time.Millisecond)
	rec := tr.Stop()

	for _, b := range rec.Bounds {
		if b.W == 0 || b.H == 0 {
			t.Fatalf("a degenerate rectangle was recorded: %+v", b)
		}
	}
}

// No surface attached is the pre-existing whole-screen path, and it must stay
// exactly as it was: samples, no bounds, nothing claiming to be mapped.
func TestSessionWithoutASurfaceRecordsNoBounds(t *testing.T) {
	fakePointer(t, func(i int) (int, int) { return i, i }, nil)
	fakeSurfaces(t, nil, func(string) (Rect, bool) { return Rect{}, false })

	var tr Tracker
	tr.Start()
	time.Sleep(200 * time.Millisecond)
	rec := tr.Stop()

	if rec.Surface != nil {
		t.Errorf("unattached session claims surface %+v", rec.Surface)
	}
	if len(rec.Bounds) != 0 {
		t.Errorf("unattached session recorded %d bounds", len(rec.Bounds))
	}
	if len(rec.Samples) == 0 {
		t.Error("unattached session recorded no pointer samples at all")
	}
}

// Restarting must not leak the previous take's surface into the new one — a
// second recording of a different window would otherwise be mapped through the
// first window's rectangle.
func TestRestartClearsTheAttachedSurface(t *testing.T) {
	fakePointer(t, func(i int) (int, int) { return i, i }, nil)
	fakeSurfaces(t,
		[]Surface{{ID: "window:7", Kind: "window", Rect: Rect{X: 0, Y: 0, W: 800, H: 600}}},
		func(string) (Rect, bool) { return Rect{X: 0, Y: 0, W: 800, H: 600}, true })

	var tr Tracker
	tr.Start()
	tr.Attach("window:7")
	time.Sleep(80 * time.Millisecond)
	tr.Start()
	time.Sleep(150 * time.Millisecond)
	rec := tr.Stop()

	if rec.Surface != nil {
		t.Errorf("restarted session inherited surface %+v", rec.Surface)
	}
	if len(rec.Bounds) != 0 {
		t.Errorf("restarted session inherited %d bounds", len(rec.Bounds))
	}
}
