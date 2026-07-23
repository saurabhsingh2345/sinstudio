package render

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// Every kind must have a screen that is actually inside its own device and
// inside the canvas. A screen rect that overhangs produces a pad with a
// negative offset, which fails the whole export rather than just looking wrong.
func TestDeviceLayoutStaysOnCanvas(t *testing.T) {
	for _, kind := range []string{schema.DeviceBrowser, schema.DevicePhone, schema.DeviceTablet, schema.DeviceLaptop} {
		for _, c := range [][2]int{{1920, 1080}, {1080, 1920}, {1080, 1080}, {3840, 2160}, {640, 360}} {
			g := deviceLayout(kind, c[0], c[1])
			if g.x < 0 || g.y < 0 {
				t.Errorf("%s @%dx%d: negative origin (%d,%d)", kind, c[0], c[1], g.x, g.y)
			}
			if g.x+g.w > c[0] || g.y+g.h > c[1] {
				t.Errorf("%s @%dx%d: screen %d+%d x %d+%d overhangs", kind, c[0], c[1], g.x, g.w, g.y, g.h)
			}
			if g.w < 2 || g.h < 2 {
				t.Errorf("%s @%dx%d: degenerate screen %dx%d", kind, c[0], c[1], g.w, g.h)
			}
		}
	}
}

// scale and pad targets must be even for the same 4:2:0 reason the region
// recorder has: an odd target is either refused or silently shifted.
func TestDeviceLayoutIsEven(t *testing.T) {
	for _, kind := range []string{schema.DeviceBrowser, schema.DevicePhone, schema.DeviceTablet, schema.DeviceLaptop} {
		g := deviceLayout(kind, 1917, 1083) // deliberately odd canvas
		for _, v := range []int{g.x, g.y, g.w, g.h} {
			if v%2 != 0 {
				t.Errorf("%s: %d is odd", kind, v)
			}
		}
	}
}

// An unknown kind must still produce a usable frame rather than a zero-sized
// one — the document can name anything, and a degenerate crop fails the export.
func TestUnknownDeviceFallsBackToSomethingRenderable(t *testing.T) {
	g := deviceLayout("teapot", 1920, 1080)
	if g.w < 2 || g.h < 2 {
		t.Fatalf("unknown kind gave a degenerate screen %dx%d", g.w, g.h)
	}
}

/*
The picture must be FITTED into the screen, never stretched.

A 16:9 recording squeezed into a phone's portrait screen is worse than the
letterboxing that avoids it, and force_original_aspect_ratio is the only thing
standing between the two.
*/
func TestDeviceFiltergraph(t *testing.T) {
	var fc strings.Builder
	g := deviceGeom{x: 100, y: 50, w: 800, h: 450}
	out := writeDeviceFrame(&fc, "[in]", 0, 7, g, 1920, 1080)
	s := fc.String()

	if !strings.Contains(s, "force_original_aspect_ratio=decrease") {
		t.Errorf("picture must be fitted, not stretched: %q", s)
	}
	if !strings.Contains(s, "scale=800:450") {
		t.Errorf("must scale into the screen rect: %q", s)
	}
	if !strings.Contains(s, "pad=1920:1080:100:50") {
		t.Errorf("must place the screen at the frame's own coordinates: %q", s)
	}
	if !strings.Contains(s, "[7:v]") {
		t.Errorf("must read the frame from its own input: %q", s)
	}
	// The frame goes OVER the picture; the other order hides the video.
	si := strings.Index(s, "[dvs0][dvf0]overlay")
	if si < 0 {
		t.Errorf("frame must be overlaid on the picture: %q", s)
	}
	if out != "[dv0]" {
		t.Errorf("out = %q", out)
	}
}

/*
The end-to-end promise in exported pixels: the recording appears inside the
screen opening, and the frame's body is drawn around it.

Checking only "something rendered" would pass with the frame covering the video
entirely, which is exactly what a wrong overlay order produces.
*/
func TestDeviceFramePutsThePictureInTheScreen(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 960, 540
	src := filepath.Join(dir, "red.mp4")
	// A flat red source, so "the picture" is unmistakable against the frame.
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=960x540:r=24:d=2", "-frames:v", "48", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 1,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Device:    &schema.DeviceFrame{Kind: schema.DeviceBrowser},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 0.5)
	g := deviceLayout(schema.DeviceBrowser, W, H)

	// Centre of the screen opening: the recording.
	r, gg, b := meanRGB(t, frame, g.x+g.w/2, g.y+g.h/2)
	if !(r > 120 && r > gg*2 && r > b*2) {
		t.Errorf("screen centre = rgb(%.0f,%.0f,%.0f), want the red recording", r, gg, b)
	}

	// Just above the opening: the browser's title bar, which is neither the
	// recording nor the backdrop behind the device.
	r, gg, b = meanRGB(t, frame, g.x+g.w/2, g.y-10)
	if r > 100 && r > gg*2 {
		t.Errorf("above the screen = rgb(%.0f,%.0f,%.0f), want frame, not the picture", r, gg, b)
	}
	if b > 180 && b > r*2 && b > gg*2 {
		t.Errorf("above the screen = rgb(%.0f,%.0f,%.0f), want frame, not the backdrop", r, gg, b)
	}

	// The canvas corner is outside the device entirely: the backdrop.
	r, gg, b = meanRGB(t, frame, 8, 8)
	if !(b > 150 && r < 100) {
		t.Errorf("canvas corner = rgb(%.0f,%.0f,%.0f), want the backdrop", r, gg, b)
	}
}

// A device frame has to survive the clip's own transform, since the whole point
// of compositing before the scale is that the two move as one object.
func TestDeviceFrameSurvivesAZoom(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360
	src := filepath.Join(dir, "red.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=640x360:r=24:d=2", "-frames:v", "48", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 1,
				Transform: schema.Transform{Scale: 1.4, Opacity: 1},
				Device:    &schema.DeviceFrame{Kind: schema.DevicePhone},
			}}},
		},
	}
	out := filepath.Join(dir, "z.mp4")
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("zoomed device export failed: %v\n%s", err, b)
	}
}

// Redactions are fractions of the clip's own picture, so they must be applied
// while that is still what the stream is — before the device insets it. If the
// order ever flipped, a redaction would land at the wrong place AND at the wrong
// size, so this pins that both can be on at once without the export failing.
func TestDeviceFrameComposesWithARedaction(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360
	src := filepath.Join(dir, "red.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=640x360:r=24:d=2", "-frames:v", "48", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c", AssetID: "a", Start: 0, In: 0, Out: 1,
			Transform:  schema.Transform{Scale: 1, Opacity: 1},
			Device:     &schema.DeviceFrame{Kind: schema.DeviceLaptop},
			Redactions: []schema.Redaction{{Kind: schema.RedactBlur, X: 0.2, Y: 0.2, W: 0.3, H: 0.3}},
		}}}},
	}
	out := filepath.Join(dir, "r.mp4")
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("device + redaction export failed: %v\n%s", err, b)
	}
}
