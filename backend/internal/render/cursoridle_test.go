package render

import (
	"fmt"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// walk builds a sample track: one sample per entry, 100ms apart unless a
// heartbeat is asked for. Positions are in recording pixels.
func walk(pts [][2]int, stepMS int64) []cursor.Sample {
	out := make([]cursor.Sample, len(pts))
	for i, p := range pts {
		out[i] = cursor.Sample{T: int64(i) * stepMS, X: p[0], Y: p[1]}
	}
	return out
}

// park appends the sampler's 250ms heartbeat at a fixed position, which is what
// a genuinely abandoned pointer looks like in a real sidecar.
func park(s []cursor.Sample, at [2]int, from, to int64) []cursor.Sample {
	for t := from; t <= to; t += 250 {
		s = append(s, cursor.Sample{T: t, X: at[0], Y: at[1]})
	}
	return s
}

func TestIdleSpansIgnoreAMovingPointer(t *testing.T) {
	// A steady drift across the screen never rests, so nothing should hide.
	s := walk([][2]int{{0, 0}, {40, 0}, {80, 0}, {120, 0}, {160, 0}}, 100)
	if got := pointerIdleSpans(s, 1920, 1); len(got) != 0 {
		t.Fatalf("moving pointer produced spans: %+v", got)
	}
}

func TestIdleSpansFindAPark(t *testing.T) {
	s := walk([][2]int{{0, 0}, {100, 0}}, 100)
	s = park(s, [2]int{100, 0}, 200, 3000)
	s = append(s, cursor.Sample{T: 3100, X: 400, Y: 200})

	spans := pointerIdleSpans(s, 1920, 1)
	if len(spans) != 1 {
		t.Fatalf("want 1 span, got %+v", spans)
	}
	// The park starts at the last real movement (t=0.1) and ends when the
	// pointer moves again (t=3.1).
	if math.Abs(spans[0].Start-0.1) > 1e-9 || math.Abs(spans[0].End-3.1) > 1e-9 {
		t.Fatalf("span = %+v, want {0.1 3.1}", spans[0])
	}
}

func TestIdleSpansAreBrokenByAClick(t *testing.T) {
	// The pointer never moves, but it is clicked halfway through. Clicking
	// without nudging the mouse is the pointer being used; fading it out mid
	// press would be absurd.
	var s []cursor.Sample
	s = park(s, [2]int{50, 50}, 0, 5000)
	for i := range s {
		if s[i].T == 2500 {
			s[i].Down = 1
		}
	}
	spans := pointerIdleSpans(s, 1920, 1)
	if len(spans) != 2 {
		t.Fatalf("a click should split the park in two, got %+v", spans)
	}
	if math.Abs(spans[0].End-2.5) > 1e-9 || math.Abs(spans[1].Start-2.75) > 1e-9 {
		t.Fatalf("split at the wrong place: %+v", spans)
	}
}

func TestIdleToleranceScalesWithTheCapture(t *testing.T) {
	// A 4px wobble is motion at 1920 and jitter at 4K, because the tolerance is
	// quoted at a 1920 reference. Quoting it absolutely is the bug the focus
	// radii already had once.
	var s []cursor.Sample
	for t := int64(0); t <= 4000; t += 250 {
		x := 50
		if t%500 == 0 {
			x = 54
		}
		s = append(s, cursor.Sample{T: t, X: x, Y: 50})
	}
	if got := pointerIdleSpans(s, 1920, 1); len(got) != 0 {
		t.Fatalf("4px wobble at 1920 should count as movement, got %+v", got)
	}
	if got := pointerIdleSpans(s, 3840, 1); len(got) != 1 {
		t.Fatalf("the same wobble at 4K should count as parked, got %+v", got)
	}
}

// TestPointerAlphaGolden pins the exact ramp. cursor-draw.ts asserts the same
// numbers; the pair is what keeps the preview's fade and the export's fade the
// same fade.
func TestPointerAlphaGolden(t *testing.T) {
	spans := []idleSpan{{Start: 1, End: 5}}
	const hideAfter = 2.0
	cases := []struct {
		t    float64
		want float64
	}{
		{0.5, 1},     // before the park
		{2.9, 1},     // parked, but not yet past the threshold
		{3.0, 1},     // the threshold itself: still fully drawn
		{3.225, 0.5}, // half way through the 0.45s fade out
		{3.45, 0},    // gone
		{4.5, 0},     // still gone
		{5.0, 0},     // the moment it moves
		{5.06, 0.5},  // half way through the 0.12s fade in
		{5.12, 1},    // back
		{9.0, 1},     // long after
	}
	for _, c := range cases {
		if got := pointerAlphaAt(spans, hideAfter, c.t); math.Abs(got-c.want) > 1e-6 {
			t.Errorf("alpha(%.3f) = %.6f, want %.6f", c.t, got, c.want)
		}
	}
}

func TestPointerAlphaReturnsFromWhereItGot(t *testing.T) {
	// A park that ends mid-fade must come back from the alpha it actually
	// reached. Snapping to zero first would flash the cursor out and in.
	spans := []idleSpan{{Start: 0, End: 2.2}}
	const hideAfter = 2.0
	mid := pointerAlphaAt(spans, hideAfter, 2.2)
	if math.Abs(mid-(1-0.2/pointerFadeOut)) > 1e-6 {
		t.Fatalf("alpha at the end of a short park = %.4f", mid)
	}
	// Half a fade-in later it should be half way from there back to 1.
	got := pointerAlphaAt(spans, hideAfter, 2.2+pointerFadeIn/2)
	if want := mid + (1-mid)*0.5; math.Abs(got-want) > 1e-6 {
		t.Fatalf("fade in from %.4f gave %.4f, want %.4f", mid, got, want)
	}
}

func TestAlphaStepsRampAndSettle(t *testing.T) {
	spans := []idleSpan{{Start: 1, End: 5}}
	steps := pointerAlphaSteps(spans, 2)
	if len(steps) == 0 {
		t.Fatal("no steps emitted")
	}
	for i := 1; i < len(steps); i++ {
		if steps[i].T < steps[i-1].T {
			t.Fatalf("steps out of order at %d: %+v", i, steps[i-1:i+1])
		}
	}
	if first := steps[0]; math.Abs(first.T-3) > 1e-9 || math.Abs(first.A-1) > 1e-9 {
		t.Fatalf("ramp should be pinned at full opacity when the fade starts, got %+v", first)
	}
	if last := steps[len(steps)-1]; math.Abs(last.A-1) > 1e-9 {
		t.Fatalf("ramp should settle back at 1, got %+v", last)
	}
	// Every emitted value must agree with the continuous function it samples.
	for _, s := range steps {
		if want := pointerAlphaAt(spans, 2, s.T); math.Abs(s.A-want) > 0.002 {
			t.Errorf("step at %.3f = %.4f, but alphaAt = %.4f", s.T, s.A, want)
		}
	}
	// A silent no-op is the failure mode that matters: the flat stretch between
	// fades must not be spelled out sample by sample.
	if len(steps) > 30 {
		t.Fatalf("ramp is too chatty: %d steps for one park", len(steps))
	}
}

func TestAlphaStepsEmptyWithoutSpans(t *testing.T) {
	if got := pointerAlphaSteps(nil, 2); len(got) != 0 {
		t.Fatalf("want no steps, got %+v", got)
	}
}

// The end-to-end check, and the only one that can catch the failure that
// matters: a sendcmd naming a filter that isn't there, or an alpha gain the
// build silently ignores, looks exactly like success everywhere else. So this
// renders real frames and counts the cursor's pixels.
func TestAutoHideActuallyRemovesTheCursor(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	// Parked at one spot for the whole clip, with the heartbeat a real sidecar
	// carries. Hidden, because a drawn pointer is the only kind that can fade.
	var samples []cursor.Sample
	for ms := int64(0); ms <= 2900; ms += 250 {
		samples = append(samples, cursor.Sample{T: ms, X: 320, Y: 180})
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	// autoHide=1 ⇒ full opacity until 1.0, gone by 1.45.
	//
	// Measured as red ENERGY rather than a count of pixels over a threshold.
	// Alpha scales every one of the cursor's pixels toward the black behind it,
	// so a thresholded count falls off a cliff somewhere in the middle of the
	// fade and reports "gone" while half the cursor is still visible. Energy is
	// linear in alpha, which is the thing being asserted.
	frame := func(at float64) float64 {
		t.Helper()
		doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
			Size: 60, Color: "#ff0000", Opacity: 1, AutoHide: 1,
		}})
		out := filepath.Join(dir, fmt.Sprintf("f%.0f.png", at*1000))
		plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir,
			Options{FrameAt: at})
		if err != nil {
			t.Fatal(err)
		}
		if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg at %.2fs: %v\n%s", at, err, lastLines(string(b), 8))
		}
		return redEnergy(t, out)
	}

	before := frame(0.5)
	if before <= 0 {
		t.Fatal("no cursor drawn before the idle threshold — the test proves nothing")
	}
	if after := frame(2.0); after > before*0.02 {
		t.Errorf("cursor still on screen a second after it should have faded: %.1f (was %.1f)", after, before)
	}
	// Mid-fade it must be genuinely part-way, not snapped to either end. A step
	// instead of a ramp is the shape a sendcmd script with one bad time takes,
	// and it renders without complaint.
	if mid := frame(1.225); mid < before*0.3 || mid > before*0.7 {
		t.Errorf("half way through the fade the cursor measured %.1f, want about half of %.1f", mid, before)
	}
}

// redEnergy totals how much red the frame carries where red dominates — a
// measure that falls linearly with alpha instead of falling off a threshold.
func redEnergy(t *testing.T, path string) float64 {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	var sum float64
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			if r > g && r > bl {
				sum += float64(r-(g+bl)/2) / 65535
			}
		}
	}
	return sum
}

// A clip that never asks for auto-hide must compile the graph it always did.
func TestAutoHideIsAbsentWhenOff(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	writeTrackHidden(t, src, 640, 360, samplePath(), true)

	doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{Size: 60}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(dir, "o.mp4"), dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(plan.Args, " "), "colorchannelmixer@") {
		t.Error("an alpha gain was added to a clip that never fades")
	}
}
