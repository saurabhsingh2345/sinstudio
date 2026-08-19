package render

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

// TestCrossDissolveNeverShowsTheBackground is the pixel-level proof of the fix,
// against the exported render rather than the preview's arithmetic.
//
// Two clips laid end to end, the second one fading in, over a canvas painted
// PURE BLUE so that any bleed is unmistakable — the clips are flat colours too,
// so the frame centre reports the mix the compositor arrived at. Halfway through
// the transition the frame has to be a mix of the two scenes — red under green —
// and carry no blue at all. Before the fix the first clip had already ended, so the same
// frame was half green and half canvas: the flash of flat colour on every cut.
func TestCrossDissolveNeverShowsTheBackground(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	red := filepath.Join(dir, "red.mp4")
	green := filepath.Join(dir, "green.mp4")
	makeTestClip(t, red, "red")
	makeTestClip(t, green, "green")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{
				{
					ID: "a", AssetID: "red", Start: 0, In: 0, Out: 2,
					Transform: schema.Transform{Scale: 1, Opacity: 1},
				},
				{
					ID: "b", AssetID: "green", Start: 2, In: 0, Out: 2,
					Transform:    schema.Transform{Scale: 1, Opacity: 1},
					TransitionIn: &schema.Transition{Type: "fade", Duration: 0.5},
				},
			}},
		},
	}
	resolve := func(id string) (string, bool) {
		switch id {
		case "red":
			return red, true
		case "green":
			return green, true
		}
		return "", false
	}
	frame := func(at float64) (float64, float64, float64) {
		out := filepath.Join(dir, fmt.Sprintf("f-%.2f.png", at))
		plan, err := Compile(doc, resolve, out, dir, Options{FrameAt: at})
		if err != nil {
			t.Fatalf("compile @%.2f: %v", at, err)
		}
		if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg @%.2f: %v\n%s", at, err, b)
		}
		return meanRGB(t, out, 160, 90) // frame centre; both sources are flat
	}

	// Sanity: each scene on its own, and no canvas showing through either.
	if r, g, b := frame(1); r < 180 || g > 80 || b > 60 {
		t.Errorf("first scene alone = (%.0f,%.0f,%.0f), want red", r, g, b)
	}
	if r, g, b := frame(3); g < 100 || r > 80 || b > 60 {
		t.Errorf("second scene alone = (%.0f,%.0f,%.0f), want green", r, g, b)
	}

	// Halfway through the dissolve: both scenes present, canvas absent.
	r, g, b := frame(2.25)
	if b > 40 {
		t.Errorf("blue = %.0f mid-dissolve — the canvas is showing through a cut (%.0f,%.0f,%.0f)", b, r, g, b)
	}
	if r < 40 {
		t.Errorf("red = %.0f mid-dissolve — the outgoing scene is not held under the transition", r)
	}
	if g < 40 {
		t.Errorf("green = %.0f mid-dissolve — the incoming scene is not rising", g)
	}
}
