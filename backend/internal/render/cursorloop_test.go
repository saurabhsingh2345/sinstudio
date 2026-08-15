package render

import (
	"math"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// A straight walk from the top-left to the bottom-right, one sample per 100ms.
func walkAway() []cursor.Sample {
	var out []cursor.Sample
	for i := 0; i <= 30; i++ {
		out = append(out, cursor.Sample{T: int64(i * 100), X: i * 10, Y: i * 5})
	}
	return out
}

func TestLoopReturnLandsExactlyWhereItStarted(t *testing.T) {
	s := walkAway()
	got := loopReturnPath(s, 1.0, 0, 3.0)
	last := got[len(got)-1]
	if last.X != s[0].X || last.Y != s[0].Y {
		t.Errorf("ended at (%d,%d), want the start (%d,%d)", last.X, last.Y, s[0].X, s[0].Y)
	}
}

func TestLoopReturnLeavesTheRestAlone(t *testing.T) {
	s := walkAway()
	got := loopReturnPath(s, 1.0, 0, 3.0)
	for i, o := range got {
		if t0 := float64(s[i].T) / 1000; t0 > 2.0 {
			continue
		}
		if o != s[i] {
			t.Fatalf("sample at %dms changed outside the return window: %+v → %+v", s[i].T, s[i], o)
		}
	}
}

// The glide has to leave and arrive at rest. A linear walk home reads as the
// cursor being dragged by something.
func TestLoopReturnEasesRatherThanDrags(t *testing.T) {
	// A pointer parked away from home for the whole take, so any movement in
	// the window is the glide and nothing else.
	var s []cursor.Sample
	for ms := int64(0); ms <= 3000; ms += 100 {
		x := 500
		if ms == 0 {
			x = 0
		}
		s = append(s, cursor.Sample{T: ms, X: x, Y: 0})
	}
	got := loopReturnPath(s, 2.0, 0, 3.0)

	// Displacement per step must rise then fall — the shape of a smootherstep,
	// not the flat profile of a linear ramp.
	var steps []float64
	for i := 1; i < len(got); i++ {
		if float64(got[i].T)/1000 <= 1.0 {
			continue
		}
		steps = append(steps, math.Abs(float64(got[i].X-got[i-1].X)))
	}
	if len(steps) < 6 {
		t.Fatalf("not enough of the glide to judge: %d steps", len(steps))
	}
	first, mid, last := steps[0], steps[len(steps)/2], steps[len(steps)-1]
	if mid <= first || mid <= last {
		t.Errorf("glide is not eased: first %.1f, middle %.1f, last %.1f", first, mid, last)
	}
}

// THE rule: the glide is a fiction, and one that drags the pointer off the
// button it is pressing is worse than the jump it fixes.
func TestLoopReturnNeverMovesTheCursorThroughAClick(t *testing.T) {
	var s []cursor.Sample
	for i := 0; i <= 30; i++ {
		smp := cursor.Sample{T: int64(i * 100), X: 400, Y: 400}
		if i == 0 {
			smp.X, smp.Y = 0, 0
		}
		// A click at 2.5s, well inside a 2s return window.
		if i == 25 {
			smp.Down = cursor.ButtonLeft
		}
		s = append(s, smp)
	}
	got := loopReturnPath(s, 2.0, 0, 3.0)
	for i, o := range got {
		if s[i].Down == 0 {
			continue
		}
		if o.X != s[i].X || o.Y != s[i].Y {
			t.Errorf("the pointer was moved during a press: (%d,%d) → (%d,%d)",
				s[i].X, s[i].Y, o.X, o.Y)
		}
	}
	// The glide is shortened, not abandoned: it still gets home.
	if last := got[len(got)-1]; last.X != 0 || last.Y != 0 {
		t.Errorf("gave up on the return after the click: ended at (%d,%d)", last.X, last.Y)
	}
	// And it starts only after the click has had time to read.
	for i, o := range got {
		if t0 := float64(s[i].T) / 1000; t0 <= 2.5+loopClickHold && o != s[i] {
			t.Errorf("glide began %.2fs, before the click's ring could read", t0)
			break
		}
	}
}

// A trimmed clip loops at its own out point. Gliding home over a stretch that
// was cut is no glide at all.
func TestLoopReturnUsesTheClipsRangeNotTheTracks(t *testing.T) {
	s := walkAway() // runs to 3.0s
	// The clip only shows 0.5s..2.0s, so it must be home at 2.0s.
	got := loopReturnPath(s, 1.0, 0.5, 2.0)
	tr := &cursor.Track{Samples: got}
	hx, hy := tr.At(0.5)
	ex, ey := tr.At(2.0)
	if ex != hx || ey != hy {
		t.Errorf("at the clip's out the cursor was at (%d,%d), want its in (%d,%d)", ex, ey, hx, hy)
	}
	// Past the out point nothing is touched — those samples are not rendered.
	if got[len(got)-1] != s[len(s)-1] {
		t.Error("samples past the clip's out were rewritten")
	}
}

func TestLoopReturnIsANoOpWhenOff(t *testing.T) {
	s := walkAway()
	for _, c := range []struct{ dur, from, to float64 }{
		{0, 0, 3}, {1, 3, 3}, {1, 3, 1},
	} {
		got := loopReturnPath(s, c.dur, c.from, c.to)
		for i := range got {
			if got[i] != s[i] {
				t.Fatalf("dur=%v from=%v to=%v changed the path", c.dur, c.from, c.to)
			}
		}
	}
}

// The end-to-end check: at the loop point the drawn cursor has to be back where
// the clip's first frame had it, or the loop still jumps.
func TestLoopReturnPutsTheDrawnCursorBackOnScreen(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	// Starts top-left, walks to the far corner and stays there.
	var samples []cursor.Sample
	for ms := int64(0); ms <= 2900; ms += 100 {
		x, y := 80, 60
		if ms > 500 {
			x, y = 520, 280
		}
		samples = append(samples, cursor.Sample{T: ms, X: x, Y: y})
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	frame := func(at float64, loop float64) (float64, float64) {
		t.Helper()
		doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
			Size: 40, Color: "#ff0000", Opacity: 1, Style: "dot", LoopReturn: loop,
		}})
		out := filepath.Join(dir, "f.png")
		plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir,
			Options{FrameAt: at})
		if err != nil {
			t.Fatal(err)
		}
		if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg at %.2f: %v\n%s", at, err, lastLines(string(b), 8))
		}
		x, y, n := redCentroid(t, out)
		if n == 0 {
			t.Fatalf("no cursor in the frame at %.2fs", at)
		}
		return x, y
	}

	// The loop point is the clip's LAST FRAME, not a moment near the end: the
	// glide is still arriving at 2.8s, and asserting there measures the ease
	// rather than the landing.
	const loopPoint = 3.0 // clamped to the last frame by Compile

	// Without the return it ends in the far corner, which is the jump.
	fx, fy := frame(loopPoint, 0)
	if fx < 400 {
		t.Fatalf("the cursor was not left in the far corner: (%.0f,%.0f)", fx, fy)
	}
	// With it, the last frame matches the first.
	sx, sy := frame(0.1, 1.0)
	ex, ey := frame(loopPoint, 1.0)
	if math.Hypot(ex-sx, ey-sy) > 12 {
		t.Errorf("loop point at (%.0f,%.0f), first frame at (%.0f,%.0f)", ex, ey, sx, sy)
	}
}
