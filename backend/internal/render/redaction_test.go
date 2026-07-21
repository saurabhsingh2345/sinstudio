package render

import (
	"fmt"
	"image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

func TestValidRedactions(t *testing.T) {
	// A degenerate region cannot hide anything, and a zero-sized crop fails the
	// WHOLE export rather than just itself — so these are dropped, not passed on.
	for _, r := range []schema.Redaction{
		{Kind: "blur", W: 0, H: 0.2},
		{Kind: "blur", W: 0.2, H: 0},
		{Kind: "blur", X: 1.2, Y: 0.1, W: 0.2, H: 0.2},
		{Kind: "blur", X: -0.5, W: 0.4, H: 0.2}, // entirely off the left edge
	} {
		if got := validRedactions([]schema.Redaction{r}); len(got) != 0 {
			t.Errorf("validRedactions(%+v) kept %d, want it dropped", r, len(got))
		}
	}

	// One hanging over an edge is clamped rather than dropped: the visible part
	// still covers something the user asked to hide.
	got := validRedactions([]schema.Redaction{{Kind: "blur", X: -0.1, Y: 0.8, W: 0.5, H: 0.5}})
	if len(got) != 1 {
		t.Fatalf("kept %d, want 1", len(got))
	}
	if got[0].X != 0 {
		t.Errorf("X = %v, want 0", got[0].X)
	}
	if d := got[0].W - 0.4; d > 1e-9 || d < -1e-9 {
		t.Errorf("W = %v, want 0.4 (shrunk by the part off-frame)", got[0].W)
	}
	if d := got[0].Y + got[0].H - 1; d > 1e-9 || d < -1e-9 {
		t.Errorf("Y+H = %v, want 1 (clamped to the frame)", got[0].Y+got[0].H)
	}
}

func TestRedactFilterKinds(t *testing.T) {
	pix := redactFilter(schema.RedactPixelate, 0.5)
	if !strings.Contains(pix, "flags=neighbor") {
		t.Errorf("pixelate should resample with nearest neighbour, got %q", pix)
	}
	if strings.Contains(pix, "gblur") {
		t.Errorf("pixelate should not blur, got %q", pix)
	}

	blur := redactFilter(schema.RedactBlur, 0.5)
	if !strings.Contains(blur, "gblur") || !strings.Contains(blur, "flags=bilinear") {
		t.Errorf("blur should smooth, got %q", blur)
	}
}

func TestRedactionStrengthTreatsZeroAsUnset(t *testing.T) {
	// 0 means "not specified" everywhere else in the schema; a redaction that
	// resampled by 0 would divide by zero and produce no protection at all.
	if got := redactionStrength(0); got <= 4 {
		t.Errorf("redactionStrength(0) = %v, want a real default", got)
	}
	if redactionStrength(1) <= redactionStrength(0.1) {
		t.Error("a higher amount should redact harder")
	}
}

// The filtergraph is the real product here, so this checks its shape: the
// stream splits, the region is cropped by an EXPRESSION (not a pixel count,
// which would only be right for one source resolution), and the patch is laid
// back at the same fractions it came from.
func TestRedactionFiltergraph(t *testing.T) {
	var fc strings.Builder
	out := writeRedaction(&fc, "[in]", 0, 0, schema.Redaction{
		Kind: schema.RedactBlur, X: 0.25, Y: 0.5, W: 0.3, H: 0.2, Amount: 0.5,
	})
	g := fc.String()

	for _, want := range []string{
		"[in]split=2",
		"crop=w='max(2,iw*0.300000)'",
		"x='iw*0.250000'",
		"overlay=x='W*0.250000':y='H*0.500000'",
	} {
		if !strings.Contains(g, want) {
			t.Errorf("filtergraph missing %q\ngot: %s", want, g)
		}
	}
	if !strings.HasSuffix(g, out+";") {
		t.Errorf("chain should end at the returned label %s, got: %s", out, g)
	}
}

// Several regions chain, so a clip can hide more than one thing.
func TestRedactionsChain(t *testing.T) {
	var fc strings.Builder
	a := writeRedaction(&fc, "[in]", 0, 0, schema.Redaction{Kind: "blur", W: 0.2, H: 0.2})
	b := writeRedaction(&fc, a, 0, 1, schema.Redaction{Kind: "pixelate", X: 0.5, W: 0.2, H: 0.2})
	g := fc.String()

	if a == b {
		t.Fatal("each region needs its own output label")
	}
	if !strings.Contains(g, a+"split=2") {
		t.Errorf("the second region should redact the first's output %s\ngot: %s", a, g)
	}
}

/*
stripeSource builds a video full of fine vertical stripes — high-frequency
detail of exactly the kind a redaction has to destroy.

A solid colour would prove nothing: blurring red still gives red, and the test
would pass on a redaction that did no redacting.
*/
func stripeSource(t *testing.T, path string, w, h int) {
	t.Helper()
	var vf []string
	for x := 0; x < w; x += 8 {
		vf = append(vf, fmt.Sprintf("drawbox=x=%d:y=0:w=4:h=%d:color=white@1.0:t=fill", x, h))
	}
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=15:d=2", w, h),
		"-vf", strings.Join(vf, ","), "-frames:v", "30", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build stripe source: %v\n%s", err, b)
	}
}

// edgeEnergy measures how much detail survives in a region: the mean absolute
// horizontal luminance step. Sharp stripes score high, a smear scores near zero.
func edgeEnergy(t *testing.T, path string, x0, y0, x1, y1 int) float64 {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	sum, n := 0.0, 0
	lum := func(x, y int) float64 {
		r, g, b, _ := img.At(x, y).RGBA()
		return (0.299*float64(r) + 0.587*float64(g) + 0.114*float64(b)) / 256
	}
	for y := y0; y < y1; y++ {
		for x := x0; x < x1-1; x++ {
			sum += math.Abs(lum(x+1, y) - lum(x, y))
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

/*
The actual promise: after a redaction the detail is GONE from the exported
frame. This renders stripes, redacts the left half, and compares surviving
detail on each side — so it fails if the region lands in the wrong place, if the
resampling is too weak to hide anything, or if the filtergraph silently didn't
apply. It also covers both kinds through real ffmpeg, where the crop/scale
expression syntax is easy to get subtly wrong.
*/
func TestRedactionDestroysDetailInTheExport(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	const W, H = 320, 180

	for _, kind := range []string{schema.RedactBlur, schema.RedactPixelate} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			src := filepath.Join(dir, "stripes.mp4")
			stripeSource(t, src, W, H)

			doc := &schema.EditDoc{
				Canvas: schema.Canvas{Width: W, Height: H, FPS: 15},
				Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
					ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
					Transform:  schema.Transform{Scale: 1, Opacity: 1},
					Redactions: []schema.Redaction{{Kind: kind, X: 0, Y: 0, W: 0.5, H: 1, Amount: 0.8}},
				}}}},
			}
			frame := renderFrame(t, doc, src, dir, 1)

			// Sampled away from the seam, so edge softening at the boundary can't
			// flatter either side.
			hidden := edgeEnergy(t, frame, 10, 20, W/2-10, H-20)
			visible := edgeEnergy(t, frame, W/2+10, 20, W-10, H-20)

			if visible < 1 {
				t.Fatalf("the un-redacted half has no detail either (%.3f) — bad source", visible)
			}
			if hidden > visible/4 {
				t.Errorf("redacted detail %.3f vs untouched %.3f: the region is still readable",
					hidden, visible)
			}
		})
	}
}

// A redaction must not quietly stop working when the clip is zoomed. The region
// is stored against the clip's own frame and applied before any transform, so
// it travels with the content instead of sliding off it.
func TestRedactionSurvivesAZoom(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	const W, H = 320, 180
	dir := t.TempDir()
	src := filepath.Join(dir, "stripes.mp4")
	stripeSource(t, src, W, H)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 15},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			// Zoomed 2x on the left half — the redacted region fills the frame.
			Keyframes: map[string][]schema.Keyframe{
				"scale": {{T: 0, Value: 2}, {T: 2, Value: 2}},
				"x":     {{T: 0, Value: 160}, {T: 2, Value: 160}},
			},
			Redactions: []schema.Redaction{{Kind: schema.RedactBlur, X: 0, Y: 0, W: 0.5, H: 1, Amount: 0.8}},
		}}}},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// The zoom put the redacted half across the whole frame, so detail should be
	// gone everywhere rather than only in the left half of the output.
	if got := edgeEnergy(t, frame, 20, 20, W-20, H-20); got > 3 {
		t.Errorf("detail %.3f survived a zoom into the redacted region", got)
	}
}
