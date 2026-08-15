package render

import (
	"math"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// TestClickDipGolden pins the curve. cursor-draw.test.ts asserts the same
// numbers — a press the preview shows at one depth and the export at another is
// two different videos.
func TestClickDipGolden(t *testing.T) {
	clicks := []float64{1.0}
	cases := []struct {
		t    float64
		want float64
	}{
		{0.5, 1},     // before
		{1.0, 1},     // the instant of the press, before any travel
		{1.06, 0.72}, // fully pressed: 1 - 1.0*clickDipMax
		{0.99, 1},    // a frame earlier, untouched
		{1.32, 1},    // settled
		{5.0, 1},     // long after
	}
	for _, c := range cases {
		if got := pointerClickScale(clicks, c.t, 1); math.Abs(got-c.want) > 1e-6 {
			t.Errorf("scale(%.2f) = %.6f, want %.6f", c.t, got, c.want)
		}
	}
}

func TestClickDipIsOffWhenNotAsked(t *testing.T) {
	if got := pointerClickScale([]float64{1}, 1.06, 0); got != 1 {
		t.Errorf("amount 0 still dipped: %v", got)
	}
	if got := pointerClickScale(nil, 1.06, 1); got != 1 {
		t.Errorf("no clicks still dipped: %v", got)
	}
}

func TestClickDipStrengthScales(t *testing.T) {
	full := pointerClickScale([]float64{1}, 1.06, 1)
	half := pointerClickScale([]float64{1}, 1.06, 0.5)
	if math.Abs((1-half)-(1-full)/2) > 1e-9 {
		t.Errorf("half strength gave %.4f, not half the depth of %.4f", half, full)
	}
}

// The return leg overshoots — that is what makes the press feel sprung rather
// than merely animated. Sampling only at the endpoints would miss it entirely.
func TestClickDipSpringsBackPastItsOwnSize(t *testing.T) {
	var peak float64
	for t := 1.0; t < 1.4; t += 0.005 {
		if s := pointerClickScale([]float64{1}, t, 1); s > peak {
			peak = s
		}
	}
	if peak <= 1.0001 {
		t.Errorf("no overshoot on the way back: peak %.5f", peak)
	}
	if peak > 1.06 {
		t.Errorf("overshoot of %.3f is a bounce, not a spring", peak)
	}
}

func TestDensifyKeepsTheTrackHonest(t *testing.T) {
	// Two real samples 1s apart, with a press at the first.
	samples := []cursor.Sample{
		{T: 0, X: 0, Y: 0, Down: cursor.ButtonLeft},
		{T: 1000, X: 1000, Y: 500},
	}
	dense := densifyForClicks(samples, []float64{0})

	if len(dense) <= len(samples) {
		t.Fatalf("nothing was spliced in: %d points", len(dense))
	}
	for i := 1; i < len(dense); i++ {
		if dense[i].T < dense[i-1].T {
			t.Fatalf("out of order at %d: %v", i, dense[i-1:i+1])
		}
	}
	// THE trap: a spliced sample carrying a fresh zero between two pressed ones
	// reads as a release and then a second press, inventing a click in the data
	// every other effect keys off.
	before := (&cursor.Track{Samples: samples}).ClickTimes()
	after := (&cursor.Track{Samples: dense}).ClickTimes()
	if len(before) != len(after) {
		t.Fatalf("densifying changed the clicks: %v → %v", before, after)
	}
	// Positions must follow the same line Track.At reports, or the drawn cursor
	// steps off the path every other effect is placed on.
	tr := &cursor.Track{Samples: samples}
	for _, d := range dense {
		wx, wy := tr.At(float64(d.T) / 1000)
		if abs(d.X-wx) > 1 || abs(d.Y-wy) > 1 {
			t.Errorf("at %dms densified to (%d,%d), Track.At says (%d,%d)", d.T, d.X, d.Y, wx, wy)
		}
	}
}

func TestDensifyIsANoOpWithoutClicks(t *testing.T) {
	samples := []cursor.Sample{{T: 0, X: 0, Y: 0}, {T: 1000, X: 10, Y: 10}}
	if got := densifyForClicks(samples, nil); len(got) != len(samples) {
		t.Errorf("added %d points for no clicks", len(got)-len(samples))
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// The end-to-end check. A dip that scales the image but not the hotspot offset
// looks perfectly correct in every unit test and slides the cursor off the
// thing it just clicked, which is the one place it must not move.
func TestClickDipShrinksTheCursorWithoutMovingIt(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	// Parked, with a press at 1s. Parked on purpose: the dip has to be smooth
	// at the 250ms heartbeat rate, which is exactly when a click usually lands.
	var samples []cursor.Sample
	for ms := int64(0); ms <= 2900; ms += 250 {
		s := cursor.Sample{T: ms, X: 320, Y: 180}
		if ms == 1000 {
			s.Down = cursor.ButtonLeft
		}
		samples = append(samples, s)
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	// The dot style centres its own hotspot, so a hotspot that fails to scale
	// with the image moves the cursor by size/2 × the dip — 8px here, which a
	// centroid sees plainly. On the arrow it would be a sub-pixel error.
	frame := func(at float64) (x, y float64, area float64) {
		t.Helper()
		doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
			Size: 60, Color: "#ff0000", Opacity: 1, Style: "dot", ClickDip: 1,
		}})
		out := filepath.Join(dir, "f.png")
		plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir,
			Options{FrameAt: at})
		if err != nil {
			t.Fatal(err)
		}
		if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg at %.2fs: %v\n%s", at, err, lastLines(string(b), 8))
		}
		cx, cy, n := redCentroid(t, out)
		return cx, cy, float64(n)
	}

	x0, y0, a0 := frame(0.5)
	if a0 == 0 {
		t.Fatal("no cursor drawn before the click — the test proves nothing")
	}
	x1, y1, a1 := frame(1.06) // fully pressed
	if a1 >= a0*0.9 {
		t.Errorf("cursor did not visibly shrink on the press: %.0f px → %.0f px", a0, a1)
	}
	if math.Hypot(x1-x0, y1-y0) > 2 {
		t.Errorf("the cursor moved while pressing: (%.1f,%.1f) → (%.1f,%.1f)", x0, y0, x1, y1)
	}
	// And it comes back.
	_, _, a2 := frame(1.5)
	if a2 < a0*0.9 {
		t.Errorf("cursor stayed small after the press: %.0f px, was %.0f px", a2, a0)
	}
}
