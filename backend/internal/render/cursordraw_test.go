package render

import (
	"image/color"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// The rule the whole feature rests on. A recording made before Studio started
// hiding the OS cursor has one burned into its pixels; drawing a second one
// there is the single worst outcome, so the pointer is gated on the track
// saying the real one was kept out.
func TestPointerIsNeverDrawnOverABakedInCursor(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")

	fx := &schema.CursorFX{Pointer: &schema.CursorPointer{Size: 40}}

	// hidden=false: the capture already has a cursor.
	writeTrackHidden(t, src, 640, 360, samplePath(), false)
	args := compileFor(t, cursorDoc(fx), src, dir)
	if strings.Contains(args, "-ptr.png") {
		t.Error("drew a pointer over a recording that already contains one")
	}

	// hidden=true: the capture has none, so we owe it a cursor.
	writeTrackHidden(t, src, 640, 360, samplePath(), true)
	args = compileFor(t, cursorDoc(fx), src, dir)
	if !strings.Contains(args, "-ptr.png") {
		t.Error("no pointer drawn for a recording captured without one")
	}
	if !strings.Contains(args, "overlay@ptr0") {
		t.Errorf("pointer should be a named overlay; got:\n%s", args)
	}
}

// The pointer must composite above the emphasis effects; a highlight painted
// over the cursor defeats the point of both.
func TestPointerCompositesAboveTheEffects(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")
	writeTrackHidden(t, src, 640, 360, samplePath(), true)

	args := compileFor(t, cursorDoc(&schema.CursorFX{
		Highlight: &schema.CursorHighlight{Size: 80},
		Spotlight: &schema.CursorSpotlight{Radius: 100},
		Pointer:   &schema.CursorPointer{Size: 40},
	}), src, dir)
	iSpot := strings.Index(args, "overlay@spot0")
	iHL := strings.Index(args, "overlay@hl0")
	iPtr := strings.Index(args, "overlay@ptr0")
	if iSpot < 0 || iHL < 0 || iPtr < 0 {
		t.Fatalf("missing an overlay: spot=%d hl=%d ptr=%d", iSpot, iHL, iPtr)
	}
	if !(iSpot < iHL && iHL < iPtr) {
		t.Errorf("expected spotlight → highlight → pointer, got %d/%d/%d", iSpot, iHL, iPtr)
	}
}

func TestPointerStylesRender(t *testing.T) {
	for _, style := range []string{"", "arrow", "dot", "ring"} {
		t.Run("style="+style, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, "ptr.png")
			_, _, hx, hy, err := writePointerPNG(p, style, 40, color.NRGBA{255, 255, 255, 255}, 1)
			if err != nil {
				t.Fatalf("draw: %v", err)
			}
			x, y, n := alphaCentroid(t, p)
			if n == 0 {
				t.Fatal("drew nothing")
			}
			switch style {
			case "dot", "ring":
				// A round pointer points at its own middle.
				if hx != 20 || hy != 20 {
					t.Errorf("hotspot = (%d,%d), want the centre (20,20)", hx, hy)
				}
			default:
				// An arrow points from its tip, so its ink sits down-and-right
				// of the hotspot — that is what makes the tip land on the pixel.
				if x < float64(hx) || y < float64(hy) {
					t.Errorf("arrow ink centroid (%.1f,%.1f) should sit past the tip (%d,%d)", x, y, hx, hy)
				}
			}
		})
	}
}

func TestSmoothPathLeavesTheTrackAloneWhenOff(t *testing.T) {
	in := samplePath()
	if got := smoothPath(in, 0); &got[0] != &in[0] {
		t.Error("zero smoothing should return the original slice untouched")
	}
}

// Smoothing has to reduce jitter without shifting where the path actually goes.
func TestSmoothPathReducesJitter(t *testing.T) {
	// A straight drift with alternating 1-frame noise on top.
	var in []cursor.Sample
	for i := 0; i < 60; i++ {
		jitter := 0
		if i%2 == 0 {
			jitter = 14
		}
		in = append(in, cursor.Sample{T: int64(i * 16), X: 100 + i*4 + jitter, Y: 200})
	}
	out := smoothPath(in, 1)

	rough := func(s []cursor.Sample) float64 {
		var sum float64
		for i := 2; i < len(s); i++ {
			// Second difference: how much the path changes direction per step.
			sum += math.Abs(float64(s[i].X - 2*s[i-1].X + s[i-2].X))
		}
		return sum
	}
	before, after := rough(in), rough(out)
	if after >= before*0.5 {
		t.Errorf("smoothing barely helped: roughness %.0f → %.0f", before, after)
	}
	// And it must not drag the path somewhere else entirely.
	mid := len(in) / 2
	if d := math.Abs(float64(out[mid].X - in[mid].X)); d > 20 {
		t.Errorf("smoothed point moved %.0fpx from the raw path", d)
	}
}

// A click is a claim about a specific pixel. Smoothing that slides the cursor
// off the button it clicked is worse than leaving the shake in.
func TestSmoothPathAnchorsClicks(t *testing.T) {
	var in []cursor.Sample
	for i := 0; i < 60; i++ {
		s := cursor.Sample{T: int64(i * 16), X: 100 + i*10, Y: 200}
		if i == 30 {
			s.Down = cursor.ButtonLeft
		}
		in = append(in, s)
	}
	out := smoothPath(in, 1)
	if out[30].X != in[30].X || out[30].Y != in[30].Y {
		t.Errorf("click moved from (%d,%d) to (%d,%d)", in[30].X, in[30].Y, out[30].X, out[30].Y)
	}
}

// The end-to-end check: ffmpeg must accept and render a drawn, smoothed cursor.
func TestDrawnCursorRenders(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "green")
	writeTrackHidden(t, src, 640, 360, samplePath(), true)

	out := filepath.Join(dir, "out.mp4")
	plan, err := Compile(cursorDoc(&schema.CursorFX{
		Pointer:   &schema.CursorPointer{Size: 40, Smoothing: 0.6, Style: "arrow"},
		Clicks:    &schema.CursorClicks{Size: 100},
		Highlight: &schema.CursorHighlight{Size: 70},
	}), func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, lastLines(string(b), 6))
	}
}

// Golden values shared with the TypeScript preview. See golden_test.go.
func TestSmoothPathGolden(t *testing.T) {
	out := smoothPath(goldenSamples(), 0.7)
	want := map[int][2]int{0: {124, 190}, 5: {140, 183}, 10: {174, 170}, 15: {203, 155}, 19: {221, 148}}
	for i, w := range want {
		if out[i].X != w[0] || out[i].Y != w[1] {
			t.Errorf("smoothPath[%d] = (%d,%d), want (%d,%d) — the preview asserts these same numbers",
				i, out[i].X, out[i].Y, w[0], w[1])
		}
	}
}

func TestTrackAtGolden(t *testing.T) {
	tr := &cursor.Track{Samples: goldenSamples()}
	want := map[float64][2]int{0.05: {122, 191}, 0.12: {155, 178}, 0.25: {212, 154}}
	for ts, w := range want {
		x, y := tr.At(ts)
		if x != w[0] || y != w[1] {
			t.Errorf("At(%.2f) = (%d,%d), want (%d,%d)", ts, x, y, w[0], w[1])
		}
	}
}
