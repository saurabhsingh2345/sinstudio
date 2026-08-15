package render

import (
	"image"
	_ "image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// TestPointerBlurGolden pins the sigmas. cursor-draw.test.ts asserts the same
// numbers, so a flick smears by the same amount in the preview and the export.
func TestPointerBlurGolden(t *testing.T) {
	const size, fps = 44.0, 30
	cases := []struct {
		name   string
		vx, vy float64
		amount float64
		wx, wy float64
	}{
		// Resting, and drifting slowly: nothing to smear.
		{"still", 0, 0, 1, 0, 0},
		{"slow drift", 30, 0, 1, 0, 0},
		// 900 px/s at 30fps is 30px of travel per frame.
		{"horizontal flick", 900, 0, 1, 8.8, 0},
		{"vertical flick", 0, 900, 1, 0, 8.8},
		// A diagonal smears on both axes, which is the approximation of an
		// angled blur this trades cost for.
		{"diagonal", 900, 900, 1, 8.8, 8.8},
		// Half strength halves the cap and the slope alike.
		{"half strength", 900, 0, 0.5, 4.4, 0},
		{"off", 900, 900, 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gx, gy := pointerBlurSigma(c.vx, c.vy, c.amount, size, fps)
			if math.Abs(gx-c.wx) > 0.05 || math.Abs(gy-c.wy) > 0.05 {
				t.Errorf("sigma = (%.3f,%.3f), want (%.3f,%.3f)", gx, gy, c.wx, c.wy)
			}
		})
	}
}

// The same flick smears half as far at 60fps as at 30, because the smear models
// one frame's exposure. Without this the blur would be a property of hand speed
// alone, which is not what a camera does.
func TestPointerBlurFollowsTheFrameRate(t *testing.T) {
	at30, _ := pointerBlurSigma(400, 0, 1, 200, 30)
	at60, _ := pointerBlurSigma(400, 0, 1, 200, 60)
	if at30 <= at60 {
		t.Fatalf("30fps smeared %.3f, 60fps %.3f — the slower frame rate must smear more", at30, at60)
	}
	if at30 == 0 || at60 == 0 {
		t.Fatal("the test velocities must both produce a smear or it proves nothing")
	}
}

func TestPointerBlurIsCappedBySize(t *testing.T) {
	// An absurd velocity must not dissolve the cursor into a smudge.
	gx, _ := pointerBlurSigma(1e6, 0, 1, 44, 30)
	if want := 44 * blurMaxOfSize; math.Abs(gx-want) > 1e-9 {
		t.Errorf("uncapped: %.3f, want %.3f", gx, want)
	}
	// And the cap has to scale with the cursor, or a big cursor smears less in
	// proportion than a small one.
	big, _ := pointerBlurSigma(1e6, 0, 1, 88, 30)
	if math.Abs(big-2*gx) > 1e-9 {
		t.Errorf("cap did not scale with size: %.3f vs %.3f", big, gx)
	}
}

func TestPointerBlurDegeneratesSafely(t *testing.T) {
	for _, c := range []struct {
		amount, size float64
		fps          int
	}{
		{0, 44, 30}, {1, 0, 30}, {1, 44, 0},
	} {
		if gx, gy := pointerBlurSigma(900, 900, c.amount, c.size, c.fps); gx != 0 || gy != 0 {
			t.Errorf("amount=%v size=%v fps=%v gave (%v,%v)", c.amount, c.size, c.fps, gx, gy)
		}
	}
}

// The padding exists so the smear has somewhere to go. A blurred cursor drawn
// into an image sized to the cursor is cut off square at the edges, which reads
// as a rectangle around the pointer rather than as motion.
func TestBlurPaddingMovesTheHotspotWithIt(t *testing.T) {
	dir := t.TempDir()
	for _, style := range []string{"arrow", "dot"} {
		t.Run(style, func(t *testing.T) {
			plain := filepath.Join(dir, style+"-plain.png")
			w0, h0, hx0, hy0, err := writePointerPNG(plain, style, kindArrow, 44, 0, hexColor("#ffffff", "#ffffff"), 1)
			if err != nil {
				t.Fatal(err)
			}
			padded := filepath.Join(dir, style+"-pad.png")
			pad := 10
			w1, h1, hx1, hy1, err := writePointerPNG(padded, style, kindArrow, 44, pad, hexColor("#ffffff", "#ffffff"), 1)
			if err != nil {
				t.Fatal(err)
			}
			if w1 != w0+2*pad || h1 != h0+2*pad {
				t.Errorf("padded image is %dx%d, want %dx%d", w1, h1, w0+2*pad, h0+2*pad)
			}
			// This is the one that matters: a hotspot that does not move with the
			// padding puts the cursor ten pixels off its own coordinate.
			if hx1 != hx0+pad || hy1 != hy0+pad {
				t.Errorf("hotspot moved to (%d,%d), want (%d,%d)", hx1, hy1, hx0+pad, hy0+pad)
			}
			// And the ink must actually be inside the padding, not clipped.
			cx0, cy0, n0 := alphaCentroid(t, plain)
			cx1, cy1, n1 := alphaCentroid(t, padded)
			if n1 < n0 {
				t.Errorf("padding lost ink: %d px → %d px", n0, n1)
			}
			if math.Abs((cx1-float64(pad))-cx0) > 1 || math.Abs((cy1-float64(pad))-cy0) > 1 {
				t.Errorf("drawing shifted inside the padding: (%.1f,%.1f) vs (%.1f,%.1f)+%d",
					cx1, cy1, cx0, cy0, pad)
			}
		})
	}
}

func TestBlurIsAbsentWhenOff(t *testing.T) {
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
	if strings.Contains(strings.Join(plan.Args, " "), "gblur@") {
		t.Error("a blur filter was added to a cursor that never smears")
	}
}

// The end-to-end check: a fast flick has to leave the cursor visibly softer
// than the same cursor at rest, and the render has to accept the graph at all.
func TestCursorMotionBlurSoftensAFlick(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")

	// Still for the first second, then flung across the frame.
	var samples []cursor.Sample
	for ms := int64(0); ms <= 1000; ms += 250 {
		samples = append(samples, cursor.Sample{T: ms, X: 120, Y: 180})
	}
	for ms := int64(1016); ms <= 2000; ms += 16 {
		x := 120 + int(float64(ms-1000)/1000*400)
		samples = append(samples, cursor.Sample{T: ms, X: x, Y: 180})
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	out := filepath.Join(dir, "o.mp4")
	doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
		Size: 60, Color: "#ff0000", Opacity: 1, Style: "dot", MotionBlur: 1,
	}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, lastLines(string(b), 10))
	}

	// Sharpness is the STEEPEST step across the frame, not the total.
	//
	// Summed edge energy — the measure the redaction tests use — is the wrong
	// tool here and passes with the blur fully absent: across a single edge the
	// sum of |Δ| is the total change, which is the same whether that change
	// happens in one pixel or is spread over twenty. It only detects blur where
	// there is high-frequency detail for the blur to destroy, which is why the
	// redaction tests render stripes. One disc on black has no such detail, so
	// what is measured has to be the gradient's peak.
	sharp := framePeakStep(t, dir, out, "0.5")
	smeared := framePeakStep(t, dir, out, "1.5")
	if sharp == 0 {
		t.Fatal("no cursor at rest — the test proves nothing")
	}
	if smeared >= sharp*0.8 {
		t.Errorf("a flicked cursor was as crisp as a resting one: peak step %.3f vs %.3f", smeared, sharp)
	}
}

// framePeakStep extracts one frame and returns the largest step in red between
// horizontally neighbouring pixels: near 1 for a hard edge, small for a smear.
func framePeakStep(t *testing.T, dir, video, at string) float64 {
	t.Helper()
	png := filepath.Join(dir, "e"+at+".png")
	if b, err := exec.Command("ffmpeg", "-y", "-loglevel", "error", "-ss", at, "-i", video,
		"-frames:v", "1", "-update", "1", png).CombinedOutput(); err != nil {
		t.Fatalf("extract %s: %v\n%s", at, err, b)
	}
	f, err := os.Open(png)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	var peak float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X + 1; x < b.Max.X; x++ {
			r0, _, _, _ := img.At(x-1, y).RGBA()
			r1, _, _, _ := img.At(x, y).RGBA()
			if d := math.Abs(float64(r1)-float64(r0)) / 65535; d > peak {
				peak = d
			}
		}
	}
	return peak
}
