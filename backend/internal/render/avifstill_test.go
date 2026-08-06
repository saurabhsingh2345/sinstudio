package render

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

/*
A still is held with -stream_loop, not -loop, and the reason is a whole class of
imported images.

-loop belongs to the image2 demuxer. AVIF and HEIC are ISOBMFF containers, so
ffmpeg opens them with the mov demuxer, which has no such option and rejects the
command outright:

	Option loop not found. Error opening input file .../asset_….avif

Nothing about that message says "this format", and nothing else in the export was
wrong — one screenshot dragged in from a browser failed the render. This test
needs no ffmpeg, so it holds even where the pixel test below skips.
*/
func TestStillsAreNotHeldWithTheImage2LoopOption(t *testing.T) {
	args := compileArgs(t, imageDoc(imgClip("c1", "logo", 0)))
	if strings.Contains(args, "-loop 1") {
		t.Errorf("a still is held with the image2 demuxer's -loop, which AVIF and HEIC cannot accept:\n%s", args)
	}
}

// avifStill writes a one-colour AVIF — the format a screenshot saved from a
// browser usually arrives in. Reports whether this ffmpeg can write one at all.
func avifStill(t *testing.T, path string, w, h int, colour string) bool {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=%s:s=%dx%d", colour, w, h),
		"-frames:v", "1", "-c:v", "libsvtav1", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Logf("this ffmpeg cannot write AVIF: %v\n%s", err, b)
		return false
	}
	return true
}

/*
The same guarantee against a real AVIF and a real ffmpeg.

Two things have to hold, and only the second one needs the loop. The export must
SUCCEED, which is the reported bug; and the still must still be on screen late in
its span, which is the bug the obvious fix would have introduced — dropping the
loop option entirely also opens the file, and then the single frame runs out
after one second and the picture vanishes for the rest of the clip.

So the frame is sampled at 4s, three seconds past where an unlooped still would
have ended.
*/
func TestAVIFStillSurvivesTheWholeSpan(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360

	shot := filepath.Join(dir, "shot.avif")
	if !avifStill(t, shot, W, H, "red") {
		t.Skip("no AVIF encoder to build the fixture with")
	}
	spine := filepath.Join(dir, "spine.mp4")
	if b, err := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=0x109010:s=%dx%d:r=24:d=6", W, H),
		"-pix_fmt", "yuv420p", spine).CombinedOutput(); err != nil {
		t.Fatalf("build spine: %v\n%s", err, b)
	}

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Assets: []schema.Asset{
			{ID: "vid", Kind: "video", Width: W, Height: H, Duration: 6},
			{ID: "shot", Kind: "image", Width: W, Height: H},
		},
		Tracks: []schema.Track{
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c0", AssetID: "vid", Start: 0, In: 0, Out: 6,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}}},
			{ID: "o", Kind: schema.TrackOverlay, Clips: []schema.Clip{{
				ID: "c1", AssetID: "shot", Start: 0, In: 0, Out: 5,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}}},
		},
	}

	out := filepath.Join(dir, "frame.png")
	plan, err := Compile(doc, func(id string) (string, bool) {
		if id == "shot" {
			return shot, true
		}
		return spine, true
	}, out, dir, Options{FrameAt: 4})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("export with an AVIF still failed: %v\n%s", err, b)
	}

	// The still covers the canvas, so the middle of the frame is its red — not
	// the spine's green showing through where the picture ran out.
	r, g, b := meanRGB(t, out, W/2, H/2)
	if !(r > 100 && r > g*2) {
		t.Errorf("centre at 4s = rgb(%.0f,%.0f,%.0f), want the AVIF's red — the still stopped early", r, g, b)
	}
}
