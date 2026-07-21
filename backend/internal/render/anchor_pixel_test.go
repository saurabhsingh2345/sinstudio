package render

import (
	"context"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

// markerSource renders a dark clip with a small bright-red square centred at
// (mx,my), so a rendered frame can be searched for exactly one known feature.
func markerSource(t *testing.T, path string, w, h, mx, my int) {
	t.Helper()
	const side = 40
	vf := fmt.Sprintf("drawbox=x=%d:y=%d:w=%d:h=%d:color=red@1.0:t=fill",
		mx-side/2, my-side/2, side, side)
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=0x101010:s=%dx%d:r=24:d=5", w, h),
		"-vf", vf, "-frames:v", "120", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build marker source: %v\n%s", err, b)
	}
}

// redCentroid returns the mean position of strongly-red pixels, which locates
// the marker regardless of scaling blur at its edges.
func redCentroid(t *testing.T, path string) (float64, float64, int) {
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
	var sx, sy float64
	var n int
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			// 16-bit components; require red clearly dominant.
			if r>>8 > 120 && r > g*2 && r > bl*2 {
				sx += float64(x)
				sy += float64(y)
				n++
			}
		}
	}
	if n == 0 {
		return 0, 0, 0
	}
	return sx / float64(n), sy / float64(n), n
}

func renderFrame(t *testing.T, doc *schema.EditDoc, src, dir string, at float64) string {
	t.Helper()
	out := filepath.Join(dir, fmt.Sprintf("f-%.2f.png", at))
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir,
		Options{FrameAt: at})
	if err != nil {
		t.Fatalf("compile @%.2f: %v", at, err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg @%.2f failed: %v\n%s", at, err, b)
	}
	return out
}

// TestAnchoredZoomHoldsPointInExport is the pixel-level proof that the anchor
// does what it claims *in the exported render*, not just in the preview's math:
// a marker sitting under the anchor must not drift while the clip zooms past it.
//
// Without an anchor every zoom pulls toward frame centre, so a marker at 75%/25%
// would visibly slide outward — which is exactly the regression this catches.
func TestAnchoredZoomHoldsPointInExport(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	// Marker at 75% across, 25% down — well away from centre in both axes.
	const mx, my = W * 3 / 4, H / 4
	src := filepath.Join(dir, "marker.mp4")
	markerSource(t, src, W, H, mx, my)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 4,
			// Anchor exactly on the marker: fraction 0.75/0.25 → centre-relative +0.25/-0.25.
			Transform: schema.Transform{Scale: 1, Opacity: 1, AnchorX: 0.25, AnchorY: -0.25},
			Keyframes: map[string][]schema.Keyframe{
				"scale": {{T: 0, Value: 1, Ease: "linear"}, {T: 4, Value: 2}},
			},
		}}}},
	}

	early, late := 0.05, 3.95
	x0, y0, n0 := redCentroid(t, renderFrame(t, doc, src, dir, early))
	x1, y1, n1 := redCentroid(t, renderFrame(t, doc, src, dir, late))
	if n0 == 0 || n1 == 0 {
		t.Fatalf("marker not found (early px=%d, late px=%d)", n0, n1)
	}
	// The marker must have grown — otherwise the zoom didn't happen and the
	// "it didn't move" assertion below would pass vacuously.
	if float64(n1) < float64(n0)*2.5 {
		t.Errorf("marker should grow ~4x under a 2x zoom: early=%d late=%d", n0, n1)
	}
	// Tolerance covers scaling interpolation at the marker's edges plus the
	// ~1/24s the frame grab may land off the requested timestamp.
	const tol = 12.0
	if dx, dy := x1-x0, y1-y0; dx > tol || dx < -tol || dy > tol || dy < -tol {
		t.Errorf("anchored point drifted during zoom: (%.1f,%.1f) -> (%.1f,%.1f), delta (%.1f,%.1f)",
			x0, y0, x1, y1, dx, dy)
	}
}

// TestUnanchoredZoomPullsToCentre is the control for the test above: with the
// default centre anchor the same marker MUST slide toward the middle. If this
// ever passes-as-no-drift, the anchor test has stopped proving anything.
func TestUnanchoredZoomPullsToCentre(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	const mx, my = W * 3 / 4, H / 4
	src := filepath.Join(dir, "marker.mp4")
	markerSource(t, src, W, H, mx, my)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 4,
			Transform: schema.Transform{Scale: 1, Opacity: 1}, // centred anchor
			Keyframes: map[string][]schema.Keyframe{
				"scale": {{T: 0, Value: 1, Ease: "linear"}, {T: 4, Value: 2}},
			},
		}}}},
	}

	x0, y0, n0 := redCentroid(t, renderFrame(t, doc, src, dir, 0.05))
	x1, y1, n1 := redCentroid(t, renderFrame(t, doc, src, dir, 3.95))
	if n0 == 0 || n1 == 0 {
		t.Fatalf("marker not found (early px=%d, late px=%d)", n0, n1)
	}
	// Scaling about the centre pushes a top-right marker further right and up.
	if x1 <= x0+20 || y1 >= y0-20 {
		t.Errorf("centred zoom should push the marker away from centre: (%.1f,%.1f) -> (%.1f,%.1f)",
			x0, y0, x1, y1)
	}
}
