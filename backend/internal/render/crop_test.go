package render

import (
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

func TestCropPixelsAreAlwaysEven(t *testing.T) {
	// H.264 stores chroma at half resolution: an odd width or offset has no
	// representation in 4:2:0, and ffmpeg rounds it silently rather than
	// refusing — which shows up as a preview and an export a pixel apart.
	c := &schema.Crop{Top: 0.137, Left: 0.211, Right: 0.073, Bottom: 0.019}
	x, y, w, h := c.Pixels(1913, 1077)
	for name, v := range map[string]int{"x": x, "y": y, "w": w, "h": h} {
		if v%2 != 0 {
			t.Errorf("%s = %d, want an even number", name, v)
		}
	}
	if x+w > 1913 || y+h > 1077 {
		t.Errorf("crop %d,%d %dx%d escapes a 1913x1077 frame", x, y, w, h)
	}
}

func TestCropCannotEatTheWholeFrame(t *testing.T) {
	// Two handles dragged past each other. The result must still be a picture.
	c := &schema.Crop{Top: 0.8, Bottom: 0.8, Left: 0.95, Right: 0.95}
	_, _, w, h := c.Pixels(1920, 1080)
	if w < 2 || h < 2 {
		t.Fatalf("crop collapsed to %dx%d", w, h)
	}
	if w > 1920 || h > 1080 {
		t.Fatalf("crop grew to %dx%d", w, h)
	}
}

func TestEmptyCropIsIdentity(t *testing.T) {
	for _, c := range []*schema.Crop{nil, {}, {Top: 0, Left: 0}} {
		if !c.Empty() {
			t.Errorf("%+v should be empty", c)
		}
		if cropFilter(c, 1920, 1080) != "" {
			t.Errorf("%+v produced a filter", c)
		}
		w, h := croppedDims(1920, 1080, c)
		if w != 1920 || h != 1080 {
			t.Errorf("%+v changed the dimensions to %dx%d", c, w, h)
		}
	}
}

// An asset whose dimensions were never probed must stay unknown. Turning 0x0
// into a confident 2x2 would make the prefit letterbox every such clip into a
// speck.
func TestCropLeavesUnknownDimensionsUnknown(t *testing.T) {
	w, h := croppedDims(0, 0, &schema.Crop{Top: 0.1})
	if w != 0 || h != 0 {
		t.Errorf("croppedDims(0,0) = %dx%d, want 0x0", w, h)
	}
	if cropFilter(&schema.Crop{Top: 0.1}, 0, 0) != "" {
		t.Error("cropFilter invented a crop for a source of unknown size")
	}
}

func TestCropFilterTrimsTheRequestedEdge(t *testing.T) {
	// The headline case: cut the top quarter off a screen recording.
	got := cropFilter(&schema.Crop{Top: 0.25}, 1920, 1080)
	if got != "crop=1920:810:0:270," {
		t.Errorf("cropFilter = %q", got)
	}
	w, h := croppedDims(1920, 1080, &schema.Crop{Top: 0.25})
	if w != 1920 || h != 810 {
		t.Errorf("croppedDims = %dx%d, want 1920x810", w, h)
	}
}

/*
The pointer track has to move with the picture.

A sidecar's samples are in the recorded video's own pixels. Cropping the top off
without shifting them leaves every highlight, ring and drawn cursor exactly as
far below where it belongs as the crop was deep — which reads as the cursor
effects being miscalibrated rather than as a crop that forgot something.
*/
func TestCropShiftsTheCursorTrack(t *testing.T) {
	tr := &cursor.Track{Version: 1, Clicks: true}
	tr.Video.Width, tr.Video.Height = 1920, 1080
	tr.Samples = []cursor.Sample{
		{T: 0, X: 960, Y: 540},   // centre
		{T: 10, X: 960, Y: 100},  // inside the part being cut away
		{T: 20, X: 960, Y: 1000}, // still inside after the crop
	}

	out := cropCursor(tr, &schema.Crop{Top: 0.25})
	if out.Video.Height != 810 {
		t.Fatalf("track frame = %dx%d, want 1920x810", out.Video.Width, out.Video.Height)
	}
	if len(out.Samples) != 2 {
		t.Fatalf("want the two surviving samples, got %d", len(out.Samples))
	}
	if out.Samples[0].Y != 270 {
		t.Errorf("sample not shifted: y = %d, want 270", out.Samples[0].Y)
	}
	// Clicks and timing must survive the shift, or the rings drift off the
	// presses they mark.
	if out.Samples[1].T != 20 || out.Samples[1].Y != 730 {
		t.Errorf("second sample = %+v", out.Samples[1])
	}
	// The original must not be mutated: it is read once per export and could be
	// shared between two clips of the same asset with different crops.
	if tr.Video.Height != 1080 || len(tr.Samples) != 3 {
		t.Error("cropCursor mutated the track it was given")
	}
}

func TestCropCursorIsIdentityWithoutACrop(t *testing.T) {
	tr := &cursor.Track{Version: 1}
	tr.Video.Width, tr.Video.Height = 1920, 1080
	tr.Samples = []cursor.Sample{{T: 0, X: 5, Y: 5}}
	if got := cropCursor(tr, nil); got != tr {
		t.Error("an empty crop should hand back the same track")
	}
}

func TestPrefitModes(t *testing.T) {
	// A 4:3 source in a 16:9 canvas — the shapes genuinely disagree.
	const sw, sh, w, h = 1440, 1080, 1920, 1080

	fit := prefitFilter(schema.FitContain, sw, sh, w, h)
	if !strings.Contains(fit, "decrease") || !strings.Contains(fit, "pad=") {
		t.Errorf("fit should letterbox: %q", fit)
	}
	fill := prefitFilter(schema.FitCover, sw, sh, w, h)
	if !strings.Contains(fill, "increase") || !strings.Contains(fill, "crop=1920:1080") {
		t.Errorf("fill should cover and crop: %q", fill)
	}
	if got := prefitFilter(schema.FitStretch, sw, sh, w, h); got != "" {
		t.Errorf("stretch should add nothing, leaving the plain scale: %q", got)
	}
	// Shapes that already agree need no prefit in any mode.
	for _, mode := range []string{schema.FitAuto, schema.FitContain, schema.FitCover} {
		if got := prefitFilter(mode, 1920, 1080, w, h); got != "" {
			t.Errorf("%q prefitted a matching source: %q", mode, got)
		}
	}
}

/*
The default letterboxes, whatever else is true of the clip.

It used to fill on any clip the camera was working, so that a push-in could never
reveal the bar beside the picture — and since every screen recording carries
cursor effects, that quietly cropped a quarter off any recording whose shape did
not match the canvas. The bar is kept out of frame by the pan clamp instead (see
clipBoxAt); the default's job is only to avoid throwing away picture nobody asked
to lose.
*/
func TestAutoFitLetterboxes(t *testing.T) {
	const sw, sh, w, h = 1440, 1080, 1920, 1080
	for _, name := range []string{"a plain clip", "a clip the camera works"} {
		got := prefitFilter(schema.FitAuto, sw, sh, w, h)
		if !strings.Contains(got, "decrease") {
			t.Errorf("%s should letterbox by default: %q", name, got)
		}
	}
	// An explicit choice still wins, in both directions.
	if got := prefitFilter(schema.FitCover, sw, sh, w, h); !strings.Contains(got, "increase") {
		t.Errorf("explicit fill was ignored: %q", got)
	}
	if got := prefitFilter(schema.FitContain, sw, sh, w, h); !strings.Contains(got, "decrease") {
		t.Errorf("explicit fit was ignored: %q", got)
	}
}

/*
A crop changes the shape the prefit is fitting.

This is the whole point of the feature working end to end: trim a 16:9 recording
down to a square and the clip must letterbox as a square, not go on being
treated as 16:9 and stretched. Getting this wrong is invisible in the crop
itself and shows up as the picture being subtly the wrong shape.
*/
func TestCropChangesWhatThePrefitFits(t *testing.T) {
	// 1920x1080 with half the width cropped away is 960x1080 — taller than wide.
	cw, ch := croppedDims(1920, 1080, &schema.Crop{Left: 0.25, Right: 0.25})
	if cw != 960 || ch != 1080 {
		t.Fatalf("croppedDims = %dx%d, want 960x1080", cw, ch)
	}
	seg := prefitFilter(schema.FitContain, cw, ch, 1920, 1080)
	if !strings.Contains(seg, "pad=1920:1080") {
		t.Errorf("the cropped shape was not letterboxed into the canvas: %q", seg)
	}
	// Without the crop the source already matched the canvas and needed nothing.
	if got := prefitFilter(schema.FitContain, 1920, 1080, 1920, 1080); got != "" {
		t.Errorf("uncropped source should need no prefit: %q", got)
	}
}
