package render

import (
	"context"
	"fmt"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

func TestChromaFiltersOmittedWhenUnset(t *testing.T) {
	// Every clip runs through this, so an unkeyed one must add nothing at all —
	// a stray format=yuva420p on every visual would cost a conversion each.
	if got := chromaFilters(nil); got != "" {
		t.Errorf("chromaFilters(nil) = %q, want empty", got)
	}
}

/*
The filtergraph is the product here, so this pins its shape rather than its
bytes: alpha is made available BEFORE the key (a source decoded as yuv420p has
no alpha plane, so the key would compute and then be discarded), and despill
runs after the key rather than before it.
*/
func TestChromaFiltergraph(t *testing.T) {
	got := chromaFilters(&schema.ChromaKey{Color: "#00b140", Similarity: 0.3, Blend: 0.1})
	if !strings.HasPrefix(got, ",format=yuva420p,chromakey=") {
		t.Errorf("key must follow an alpha-capable format, got %q", got)
	}
	// ffColor uppercases; what matters is the 0x form, not the case.
	if !strings.Contains(strings.ToLower(got), "0x00b140") {
		t.Errorf("hex must be handed to ffmpeg as 0x…, got %q", got)
	}
	if strings.Contains(got, "despill") {
		t.Errorf("no spill asked for, but despill present: %q", got)
	}

	spilled := chromaFilters(&schema.ChromaKey{Color: "#00b140", Spill: 0.5})
	ki := strings.Index(spilled, "chromakey")
	di := strings.Index(spilled, "despill")
	if di < 0 || ki < 0 || di < ki {
		t.Errorf("despill must come after the key, got %q", spilled)
	}
}

func TestChromaDefaultsTreatZeroAsUnset(t *testing.T) {
	// 0 means "not specified" everywhere else in the schema. A similarity of 0
	// keys nothing at all, which looks like the feature being broken rather
	// than like a value being unset.
	got := chromaFilters(&schema.ChromaKey{})
	if !strings.Contains(got, fmt.Sprintf("%.4f", defChromaSimilarity)) {
		t.Errorf("zero similarity should fall back to a working default, got %q", got)
	}
	if !strings.Contains(strings.ToLower(got), "0x00b140") {
		t.Errorf("empty colour should fall back to chroma green, got %q", got)
	}
}

// Spill is the screen's own light bouncing onto the subject, so which cast to
// neutralise follows the key colour rather than being a separate control that
// can be set to contradict it.
func TestDespillFollowsTheKeyColour(t *testing.T) {
	if got := despillType("#00b140"); got != "green" {
		t.Errorf("green screen → %q, want green", got)
	}
	if got := despillType("#1d5ecf"); got != "blue" {
		t.Errorf("blue screen → %q, want blue", got)
	}
	if got := despillType(""); got != "green" {
		t.Errorf("unset → %q, want green (the default screen)", got)
	}
}

// greenScreenSource builds a clip that is chroma green everywhere except a red
// square standing in for the subject.
func greenScreenSource(t *testing.T, path string, w, h int) {
	t.Helper()
	vf := fmt.Sprintf("drawbox=x=%d:y=%d:w=%d:h=%d:color=red@1.0:t=fill", w/2-60, h/2-60, 120, 120)
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=0x00b140:s=%dx%d:r=24:d=3", w, h),
		"-vf", vf, "-frames:v", "72", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build green screen: %v\n%s", err, b)
	}
}

// meanRGB averages a small patch, which tolerates the codec's own noise far
// better than sampling one pixel.
func meanRGB(t *testing.T, path string, px, py int) (r, g, b float64) {
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
	const half = 6
	var n float64
	for y := py - half; y <= py+half; y++ {
		for x := px - half; x <= px+half; x++ {
			if !(inBounds(img.Bounds().Dx(), img.Bounds().Dy(), x, y)) {
				continue
			}
			cr, cg, cb, _ := img.At(x, y).RGBA()
			r += float64(cr >> 8)
			g += float64(cg >> 8)
			b += float64(cb >> 8)
			n++
		}
	}
	if n == 0 {
		t.Fatalf("no pixels sampled at (%d,%d)", px, py)
	}
	return r / n, g / n, b / n
}

func inBounds(w, h, x, y int) bool { return x >= 0 && y >= 0 && x < w && y < h }

/*
The promise, tested in exported pixels: the green disappears and what is behind
it shows through, while the subject survives.

Asserting only that "the green is gone" would pass on a filter that made the
whole clip transparent, which is the likeliest way for this to break — a key
whose similarity is too wide eats everything. So both halves are checked in one
render: the background must be visible where the screen was, and the subject
must still be there.
*/
func TestChromaKeyRevealsWhatIsBehindIt(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360
	src := filepath.Join(dir, "green.mp4")
	greenScreenSource(t, src, W, H)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			// A pure blue backdrop, so anything showing through is unambiguous.
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Chroma:    &schema.ChromaKey{Color: "#00b140", Similarity: 0.3, Blend: 0.05},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)

	// Where the screen was: the backdrop, not green.
	r, g, b := meanRGB(t, frame, 60, 60)
	if !(b > 150 && g < 90) {
		t.Errorf("keyed area = rgb(%.0f,%.0f,%.0f), want the blue backdrop showing through", r, g, b)
	}

	// Where the subject was: still red. This is what fails if the key is too wide.
	r, g, b = meanRGB(t, frame, W/2, H/2)
	if !(r > 120 && r > g*2 && r > b*2) {
		t.Errorf("subject = rgb(%.0f,%.0f,%.0f), want it kept (the key ate the subject)", r, g, b)
	}
}

/*
Without a key, the same clip must cover the backdrop completely.

This is the control for the test above: it proves the blue seen there came from
keying rather than from the clip having failed to render at all, which would
otherwise pass every assertion for entirely the wrong reason.
*/
func TestWithoutAKeyTheScreenStaysOpaque(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360
	src := filepath.Join(dir, "green.mp4")
	greenScreenSource(t, src, W, H)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)
	r, g, b := meanRGB(t, frame, 60, 60)
	if !(g > 100 && b < 120) {
		t.Errorf("unkeyed area = rgb(%.0f,%.0f,%.0f), want the green screen still opaque", r, g, b)
	}
}

/*
A key must survive a zoom.

The filter runs before scaling deliberately — keying interpolated pixels cannot
separate a real edge from one already blended with the screen — and this is what
would break if it were ever moved after it: the composite still has to hold when
the clip is scaled, which is the normal case for a webcam overlay.
*/
func TestChromaKeySurvivesAZoom(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360
	src := filepath.Join(dir, "green.mp4")
	greenScreenSource(t, src, W, H)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
				Transform: schema.Transform{Scale: 1.6, Opacity: 1},
				Chroma:    &schema.ChromaKey{Color: "#00b140", Similarity: 0.3, Blend: 0.05},
			}}},
		},
	}
	frame := renderFrame(t, doc, src, dir, 1)
	// Top-left corner is screen at any of these scales.
	r, g, b := meanRGB(t, frame, 40, 40)
	if !(b > 150 && g < 90) {
		t.Errorf("zoomed keyed area = rgb(%.0f,%.0f,%.0f), want the backdrop through", r, g, b)
	}
	r, g, b = meanRGB(t, frame, W/2, H/2)
	if !(r > 120 && r > g*2) {
		t.Errorf("zoomed subject = rgb(%.0f,%.0f,%.0f), want it kept", r, g, b)
	}
}

func TestChromaKeyOnAnActualExportRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 320, 180
	src := filepath.Join(dir, "green.mp4")
	greenScreenSource(t, src, W, H)
	out := filepath.Join(dir, "out.mp4")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#0000ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 1,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				// Spill exercised here, since despill is a separate filter that
				// may be absent from an older ffmpeg — a video export is where
				// that would surface.
				Chroma: &schema.ChromaKey{Color: "#00b140", Similarity: 0.3, Blend: 0.05, Spill: 0.4},
			}}},
		},
	}
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("export with a key failed: %v\n%s", err, b)
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		t.Fatalf("export produced nothing")
	}
}
