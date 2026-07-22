package render

import (
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// Twins with frontend/src/backdrop.test.ts — identical numbers asserted from
// both implementations, the same discipline as deviceLayout and arrowHead.
func TestBackdropLayoutGolden(t *testing.T) {
	g := backdropLayout(&schema.Backdrop{}, 1920, 1080, 1920, 1080)
	if g.x != 116 || g.y != 64 || g.w != 1688 || g.h != 950 || g.radius != 14 {
		t.Errorf("defaults 16:9 = %+v, want {116 64 1688 950 14}", g)
	}
	g = backdropLayout(&schema.Backdrop{}, 1440, 1080, 1920, 1080)
	if g.x != 326 || g.y != 64 || g.w != 1266 || g.h != 950 || g.radius != 14 {
		t.Errorf("4:3 source = %+v, want {326 64 1266 950 14}", g)
	}
	g = backdropLayout(&schema.Backdrop{Inset: 0.2, Radius: 40}, 1920, 1080, 1280, 720)
	if g.x != 256 || g.y != 144 || g.w != 768 || g.h != 432 || math.Abs(g.radius-26.666666) > 1e-3 {
		t.Errorf("inset 0.2 = %+v, want {256 144 768 432 26.667}", g)
	}
	// Unknown dims lay out as canvas-shaped.
	if backdropLayout(&schema.Backdrop{}, 0, 0, 1920, 1080) != backdropLayout(&schema.Backdrop{}, 1920, 1080, 1920, 1080) {
		t.Error("dimensionless source should lay out as canvas-shaped")
	}
}

/*
The pixel-level contract: wallpaper in the corners, the picture centred on it,
and the picture's corners rounded off — sampled from an actual rendered frame,
because that is the only level at which the alphamerge/overlay plumbing can be
wrong while every layout number is right.
*/
func TestBackdropRendersSceneAroundThePicture(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 1280, 720
	src := filepath.Join(dir, "src.mp4")
	solidSource(t, src, W, H, "0x104010") // green, canvas-shaped

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: W, Height: H}},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Backdrop:  &schema.Backdrop{Color1: "#ff00ff", Color2: "#ff00ff", Inset: 0.1, Radius: 40},
		}}}},
	}
	frame := renderFrame(t, doc, src, dir, 1)
	g := backdropLayout(doc.Tracks[0].Clips[0].Backdrop, W, H, W, H)

	// Corners: wallpaper.
	r, gr, b := meanRGB(t, frame, 20, 20)
	if !(r > 180 && b > 180 && gr < 90) {
		t.Errorf("corner = rgb(%.0f,%.0f,%.0f), want magenta wallpaper", r, gr, b)
	}
	// Centre: the picture.
	r, gr, b = meanRGB(t, frame, W/2, H/2)
	if !(gr > r && gr > 40) {
		t.Errorf("centre = rgb(%.0f,%.0f,%.0f), want the source's green", r, gr, b)
	}
	// Just inside the card's corner: still wallpaper, because the corner is
	// rounded off. A few px along the diagonal stays outside the radius arc.
	cornerX, cornerY := g.x+3, g.y+3
	r, gr, b = meanRGB(t, frame, cornerX, cornerY)
	if !(r > 150 && gr < 110) {
		t.Errorf("card corner = rgb(%.0f,%.0f,%.0f), want it rounded off (wallpaper)", r, gr, b)
	}
	// Middle of the card's top edge, just inside it (meanRGB averages a 13px
	// window, so the sample must clear the boundary): the picture.
	r, gr, b = meanRGB(t, frame, g.x+g.w/2, g.y+10)
	if !(gr > r) {
		t.Errorf("card edge = rgb(%.0f,%.0f,%.0f), want the picture", r, gr, b)
	}
}

// Without a device the backdrop replaces the prefit (it does its own fitting);
// the graph must not fit twice.
func TestBackdropSkipsPrefit(t *testing.T) {
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 1280, Height: 720, FPS: 24},
		Assets: []schema.Asset{{ID: "a", Width: 960, Height: 720}}, // mismatched
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Backdrop:  &schema.Backdrop{},
		}}}},
	}
	args := compileArgs(t, doc)
	if strings.Count(args, "force_original_aspect_ratio") != 1 {
		t.Errorf("want exactly one fit (the backdrop's own), got:\n%s", args)
	}
	if !strings.Contains(args, "alphamerge") {
		t.Error("backdrop card mask missing from the graph")
	}
}
