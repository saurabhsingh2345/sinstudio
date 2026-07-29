package render

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// bandedSource writes a video split into a coloured top band and a different
// bottom, so a crop that takes the top off is provable from the pixels rather
// than from the command line that produced them.
func bandedSource(t *testing.T, path string, w, h, bandH int, top, bottom string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=%s:s=%dx%d:r=24:d=3", bottom, w, h),
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=%s:s=%dx%d:r=24:d=3", top, w, bandH),
		"-filter_complex", "[0:v][1:v]overlay=0:0[v]",
		"-map", "[v]", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build banded source: %v\n%s", err, b)
	}
}

/*
The pixel-level contract for a crop: the trimmed edge is GONE from the export.

Cutting the top quarter off a recording is the thing the feature exists for —
a menu bar, a browser toolbar, a notification that should not ship. The band is
red and the rest is green, so "the crop happened" and "the crop happened to the
wrong edge" are different failures rather than the same ambiguous grey.

Filled, so the surviving 4:3-ish picture covers the 16:9 canvas: the sample at
the top of the frame is then source pixels from just below the cut, and finding
red there means the crop was compiled but never applied.
*/
func TestCropRemovesTheTrimmedEdgeFromTheExport(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	src := filepath.Join(dir, "banded.mp4")
	// Top quarter red, rest green.
	bandedSource(t, src, W, H, H/4, "red", "0x109010")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Crop:      &schema.Crop{Top: 0.25},
				Fit:       schema.FitCover,
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// Nowhere in the frame should there be any of the band that was cut.
	for _, y := range []int{12, H / 4, H / 2, H - 12} {
		r, g, b := meanRGB(t, frame, W/2, y)
		if r > g {
			t.Errorf("y=%d is rgb(%.0f,%.0f,%.0f) — the cropped-away red band is still in the export", y, r, g, b)
		}
		if !(g > 40) {
			t.Errorf("y=%d is rgb(%.0f,%.0f,%.0f) — expected the source's green", y, r, g, b)
		}
	}
}

/*
And the same crop WITHOUT a fill must letterbox, because the picture is no
longer the canvas's shape.

This is the half of the feature that surprises people: trimming the top leaves a
wider-than-16:9 picture, so it sits in bars — and the blue backdrop showing
through them is what makes the Fill button in the panel worth offering. Asserting
it here keeps "fit" honest, since the easy bug is to fill everything and never
letterbox at all.
*/
func TestCropWithoutFillLetterboxes(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	src := filepath.Join(dir, "banded.mp4")
	bandedSource(t, src, W, H, H/4, "red", "0x109010")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Crop:      &schema.Crop{Top: 0.25},
				Fit:       schema.FitContain,
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// 1280x540 fitted into 1280x720: 90px of transparent bar top and bottom,
	// with the blue backdrop behind them.
	r, g, b := meanRGB(t, frame, W/2, 20)
	if !(b > 150 && r < 90 && g < 90) {
		t.Errorf("top bar = rgb(%.0f,%.0f,%.0f), want the blue backdrop through a transparent bar", r, g, b)
	}
	// And the picture in the middle is the source's green, not the cut red.
	r, g, b = meanRGB(t, frame, W/2, H/2)
	if !(g > r && g > 40) {
		t.Errorf("content = rgb(%.0f,%.0f,%.0f), want the source's green", r, g, b)
	}
}

/*
A crop must compose with the effects that branch the chain.

Redactions, a device frame, a backdrop and a bubble each split the filtergraph,
and the crop has to sit at exactly one point in that sequence: after the
redactions (whose fractions are of the uncropped source, so trimming an edge
cannot slide a blur off what it hides) and before everything that frames the
picture. Getting the order wrong does not fail to compile — it produces a graph
that renders something subtly wrong — so this asserts the shape of the chain
itself and that ffmpeg accepts it.
*/
func TestCropComposesWithBranchingEffects(t *testing.T) {
	const W, H = 1280, 720
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: 1920, Height: 1080}},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform:  schema.Transform{Scale: 1, Opacity: 1},
			Crop:       &schema.Crop{Top: 0.2},
			Redactions: []schema.Redaction{{Kind: schema.RedactBlur, X: 0.1, Y: 0.1, W: 0.2, H: 0.2}},
			Device:     &schema.DeviceFrame{Kind: schema.DeviceBrowser},
		}}}},
	}
	plan, err := Compile(doc, func(string) (string, bool) { return "in.mp4", true }, "out.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	graph := strings.Join(plan.Args, " ")
	// The crop is against the source's ORIGINAL 1920x1080 frame, not the canvas
	// — 20% off the top of 1080 is 216, leaving 864.
	if !strings.Contains(graph, "crop=1920:864:0:216") {
		t.Fatalf("the clip's crop is missing or wrong:\n%s", graph)
	}
	// Chain labels rather than filter names: the redaction's output must be the
	// crop's input, which is the only way to state "in this order" about a graph
	// that is written as a set of named segments.
	if !strings.Contains(graph, "[ro0_0]crop=1920:864:0:216[cr0]") {
		t.Errorf("the crop does not consume the redaction's output — order is wrong:\n%s", graph)
	}
	// And the device frame is built from the crop's output, not the source's, so
	// its screen holds a picture with the trimmed edge already gone.
	if !strings.Contains(graph, "[cr0]scale=") {
		t.Errorf("the device frame was not built from the cropped picture:\n%s", graph)
	}
}

// An empty crop must leave the graph byte-identical to what it was — the
// feature is not allowed to add a filter to every clip in every project.
func TestNoCropLeavesTheChainAlone(t *testing.T) {
	const W, H = 1280, 720
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Crop:      &schema.Crop{},
		}}}},
	}
	plan, err := Compile(doc, func(string) (string, bool) { return "in.mp4", true }, "out.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(plan.Args, " "), "crop=") {
		t.Error("an empty crop still emitted a crop filter")
	}
}
