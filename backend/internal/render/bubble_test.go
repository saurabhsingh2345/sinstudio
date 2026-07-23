package render

import (
	"math"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

// Twins with frontend/src/bubble.test.ts.
func TestBubbleLayoutGolden(t *testing.T) {
	g := bubbleLayout(&schema.Bubble{}, 1920, 1080)
	if g.d != 302 || g.x != 808 || g.y != 388 || g.radius != 151 || g.border != 6 {
		t.Errorf("defaults = %+v, want {302 808 388 151 6}", g)
	}
	g = bubbleLayout(&schema.Bubble{Shape: "rounded"}, 1280, 720)
	if g.d != 200 || g.x != 540 || g.y != 260 || math.Abs(g.radius-36) > 1e-9 || math.Abs(g.border-4) > 1e-9 {
		t.Errorf("rounded 720p = %+v, want {200 540 260 36 4}", g)
	}
	if bubbleLayout(&schema.Bubble{Border: -1}, 1920, 1080).border != 0 {
		t.Error("negative border should mean none")
	}
}

/*
Pixel contract: outside the circle is whatever sits beneath (the backdrop
colour here — the mask made it transparent), inside is the picture, and the
ring is the ring. The centre crop is included: a wide source's edges must not
appear inside the circle.
*/
func TestBubbleRendersARoundPicture(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	src := filepath.Join(dir, "cam.mp4")
	solidSource(t, src, W, H, "0x104010")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#ff00ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Bubble:    &schema.Bubble{Border: 8, BorderColor: "#0000ff", Shadow: -1},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// Far corner: the backdrop through the transparent surround.
	r, gr, b := meanRGB(t, frame, 40, 40)
	if !(r > 180 && b > 180 && gr < 90) {
		t.Errorf("corner = rgb(%.0f,%.0f,%.0f), want magenta through", r, gr, b)
	}
	// Centre: the picture.
	r, gr, b = meanRGB(t, frame, W/2, H/2)
	if !(gr > r && gr > 40) {
		t.Errorf("centre = rgb(%.0f,%.0f,%.0f), want the source", r, gr, b)
	}
	// On the ring (left edge of the circle, mid-height): blue.
	bl := bubbleLayout(doc.Tracks[1].Clips[0].Bubble, W, H)
	r, gr, b = meanRGB(t, frame, bl.x, H/2)
	if !(b > 100 && b > gr) {
		t.Errorf("ring = rgb(%.0f,%.0f,%.0f), want the blue ring", r, gr, b)
	}
	// Just outside the circle's top-left diagonal but inside its bounding box:
	// still backdrop — the mask is a circle, not a square.
	r, gr, b = meanRGB(t, frame, bl.x+10, bl.y+10)
	if !(r > 150 && gr < 110) {
		t.Errorf("outside the arc = rgb(%.0f,%.0f,%.0f), want magenta (round mask)", r, gr, b)
	}
}
