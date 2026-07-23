package render

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// solidSource writes a video of one flat colour at the given shape.
func solidSource(t *testing.T, path string, w, h int, color string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=%s:s=%dx%d:r=24:d=3", color, w, h),
		"-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build solid source: %v\n%s", err, b)
	}
}

/*
TestMismatchedSourceIsFittedNotStretched is the pixel-level contract for the
prefit: a source whose shape is not the canvas's keeps its aspect and sits
centred, and its bars are TRANSPARENT — the backdrop shows through them, the
same picture the preview's object-fit paints. The renderer used to stretch
these clips to the canvas, so the export distorted exactly the clips the
preview letterboxed.

The backdrop is magenta so the assertion cannot pass by accident: the bars were
never magenta under the old behaviour (they were covered by stretched source),
and black bars — the other wrong answer, an opaque pad — aren't magenta either.
*/
func TestMismatchedSourceIsFittedNotStretched(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	const srcW, srcH = 960, 720 // 4:3 into 16:9
	src := filepath.Join(dir, "narrow.mp4")
	solidSource(t, src, srcW, srcH, "0x104010")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: srcW, Height: srcH}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#ff00ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// The fitted content is 960 wide, centred: bars are the outer 160px.
	r, g, b := meanRGB(t, frame, 80, H/2)
	if !(r > 180 && b > 180 && g < 90) {
		t.Errorf("left bar = rgb(%.0f,%.0f,%.0f), want the magenta backdrop through a transparent bar", r, g, b)
	}
	r, g, b = meanRGB(t, frame, W-80, H/2)
	if !(r > 180 && b > 180 && g < 90) {
		t.Errorf("right bar = rgb(%.0f,%.0f,%.0f), want the magenta backdrop through a transparent bar", r, g, b)
	}
	// And the picture itself is still there, undistorted, in the middle band.
	r, g, b = meanRGB(t, frame, W/2, H/2)
	if !(g > r && g > b && g > 40) {
		t.Errorf("content = rgb(%.0f,%.0f,%.0f), want the source's green", r, g, b)
	}
	// Just inside where the content's edge must be: source pixels, not bar.
	r, g, b = meanRGB(t, frame, 180, H/2)
	if !(g > r && g > 40) {
		t.Errorf("content edge = rgb(%.0f,%.0f,%.0f), want source pixels at 180px", r, g, b)
	}
}

// A source that already matches the canvas must compile to the exact chain it
// always had — the prefit is for mismatches, not a new tax on every clip.
func TestMatchedSourceGetsNoPrefit(t *testing.T) {
	const W, H = 1280, 720
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
		}}}},
	}
	plan, err := Compile(doc, func(string) (string, bool) { return "in.mp4", true },
		"out.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(plan.Args, " "), "force_original_aspect_ratio") {
		t.Error("matched-aspect clip was prefitted; the chain should be untouched")
	}
}

// Without probed dimensions there is nothing to fit against, and guessing
// would be worse than the stretch — so the old chain is kept.
func TestUnknownDimensionsGetNoPrefit(t *testing.T) {
	const W, H = 1280, 720
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
		}}}},
	}
	plan, err := Compile(doc, func(string) (string, bool) { return "in.mp4", true },
		"out.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(plan.Args, " "), "force_original_aspect_ratio") {
		t.Error("dimensionless clip was prefitted; without probed dims the chain must be untouched")
	}
}

// contentFrac and the frontend's contentBox (zoomPan.ts) are twins; these
// numbers are asserted on both sides so one cannot drift from the other.
func TestContentFracGolden(t *testing.T) {
	x0, y0, fw, fh := contentFrac(1440, 1080, 1920, 1080)
	if x0 != 0.125 || y0 != 0 || fw != 0.75 || fh != 1 {
		t.Errorf("4:3 in 16:9 = (%v,%v,%v,%v), want (0.125,0,0.75,1)", x0, y0, fw, fh)
	}
	// Wider than the canvas: bars above and below instead.
	x0, y0, fw, fh = contentFrac(1920, 800, 1920, 1080)
	if x0 != 0 || fw != 1 {
		t.Errorf("ultrawide x = (%v,%v)", x0, fw)
	}
	if !(y0 > 0.1294 && y0 < 0.1297) || !(fh > 0.7406 && fh < 0.7408) {
		t.Errorf("ultrawide y = (%v,%v), want (~0.12963,~0.74074)", y0, fh)
	}
	// A rounding-error mismatch is not a mismatch.
	x0, y0, fw, fh = contentFrac(1920, 1082, 1920, 1080)
	if x0 != 0 || y0 != 0 || fw != 1 || fh != 1 {
		t.Errorf("near-match was fitted: (%v,%v,%v,%v)", x0, y0, fw, fh)
	}
}
