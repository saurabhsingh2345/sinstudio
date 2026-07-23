package render

import (
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

/*
Spring easing must not show the background — proven in exported pixels.

A spring overshoots its destination. On the push-in that is the whole point; on
the way back to full frame it would drive scale below 1, and on a pan it would
run past the offset the current scale can cover. Either shows the backdrop
behind the clip for a few frames.

zoomKeyframes (TypeScript) is what decides which segments may overshoot, but the
renderer is what draws them, and the two evaluate easing independently —
easeProgress compiles an ffmpeg expression while ease() runs in the browser. So
the guarantee is checked HERE too, on the frames that actually ship: a magenta
backdrop is placed behind a clip whose keyframes carry the spring exactly where
the emitter puts it, and any magenta anywhere in any sampled frame is background
that should have been covered.

The backdrop is magenta because it appears in no natural footage and in none of
the test patterns used elsewhere in this package.
*/
func TestSpringZoomNeverExposesBackground(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360

	// A plain grey source: the test is about coverage, not content.
	src := filepath.Join(dir, "grey.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=0x808080:s=640x360:r=24:d=8",
		"-frames:v", "192", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}

	// Exactly the shape zoomKeyframes emits: springOut on the push-in, a safe
	// curve out and across. A hold at 2–4s, a pan to a second target at 5–6.5s,
	// then a full pull-out.
	kf := map[string][]schema.Keyframe{
		"scale": {
			{T: 0, Value: 1, Ease: "easeInOut"},
			{T: 1.3, Value: 1, Ease: "springOut"}, // push in
			{T: 2, Value: 1.6, Ease: "linear"},
			{T: 4, Value: 1.6, Ease: "easeInOut"}, // pan across at scale
			{T: 5, Value: 1.6, Ease: "linear"},
			{T: 6.5, Value: 1.6, Ease: "easeInOut"}, // pull out
			{T: 7.2, Value: 1, Ease: "linear"},
			{T: 8, Value: 1, Ease: "linear"},
		},
		"x": {
			{T: 0, Value: 0, Ease: "easeInOut"},
			{T: 1.3, Value: 0, Ease: "springOut"},
			// 1.6 scale over 640 wide allows |x| <= 192; sit right on the limit,
			// which is where an overshoot has nowhere to go.
			{T: 2, Value: 192, Ease: "linear"},
			{T: 4, Value: 192, Ease: "easeInOut"},
			{T: 5, Value: -192, Ease: "linear"},
			{T: 6.5, Value: -192, Ease: "easeInOut"},
			{T: 7.2, Value: 0, Ease: "linear"},
			{T: 8, Value: 0, Ease: "linear"},
		},
	}

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#ff00ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 8,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Keyframes: kf,
			}}},
		},
	}

	// Sample densely THROUGH the ramps, where an overshoot lives. Checking only
	// at the keyframes is precisely how this bug would survive.
	for _, at := range []float64{
		1.4, 1.6, 1.8, 1.95, 2.05, 2.2, // push in and settle
		4.2, 4.5, 4.8, 5.1, // the pan across
		6.6, 6.8, 7.0, 7.15, 7.3, 7.5, // pull out and settle
	} {
		frame := renderFrame(t, doc, src, dir, at)
		if n := countMagenta(t, frame); n > 0 {
			t.Errorf("t=%.2f: %d background pixels visible — the zoom uncovered the canvas", at, n)
		}
	}
}

// countMagenta counts pixels that are clearly the backdrop rather than footage.
func countMagenta(t *testing.T, path string) int {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open frame: %v", err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	b := img.Bounds()
	n := 0
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			// Red and blue high, green low — magenta, and nothing the grey
			// source or the encoder's ringing can produce.
			if r>>8 > 180 && bl>>8 > 180 && g>>8 < 90 {
				n++
			}
		}
	}
	return n
}

/*
springOut exists three times — as an ffmpeg expression (easeProgress), as a Go
number (easeValue) and in TypeScript (ease.ts) — and all three must agree.

The endpoints are where they drifted: the decaying sine has not returned to zero
by p=1, so an unpinned curve lands 0.13% past every keyed value. The numeric
halves pinned it and the expression did not, which meant the export finished
slightly off the value the preview finished exactly on. Harmless once; this is
now the default curve on every auto-zoom.
*/
func TestSpringEndpointsArePinnedEverywhere(t *testing.T) {
	if got := easeValue("springOut", 0); got != 0 {
		t.Errorf("easeValue(springOut, 0) = %v, want 0", got)
	}
	if got := easeValue("springOut", 1); got != 1 {
		t.Errorf("easeValue(springOut, 1) = %v, want 1", got)
	}
	// The compiled expression has to carry both pins, or the render lands
	// somewhere the numeric twin does not.
	expr := easeProgress("springOut", "T")
	if !strings.Contains(expr, "lte(T,0),0") {
		t.Errorf("expression is not pinned at 0: %s", expr)
	}
	if !strings.Contains(expr, "gte(T,1),1") {
		t.Errorf("expression is not pinned at 1: %s", expr)
	}
}

// The overshoot has to survive the pinning, or the curve is just a slow ease
// and none of this bought anything.
func TestSpringActuallyOvershoots(t *testing.T) {
	peak := 0.0
	for x := 0.0; x <= 1; x += 0.001 {
		if v := easeValue("springOut", x); v > peak {
			peak = v
		}
	}
	if peak <= 1.02 {
		t.Errorf("peak = %.4f, want a visible overshoot past 1", peak)
	}
}
