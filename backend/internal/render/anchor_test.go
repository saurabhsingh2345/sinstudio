package render

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// oneClipDoc is a single scaled clip, the smallest thing that shows where the
// compiler decides to put a box.
func oneClipDoc(tr schema.Transform, kf map[string][]schema.Keyframe) *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: tr, Keyframes: kf,
		}}}},
	}
}

func compileArgs(t *testing.T, doc *schema.EditDoc) string {
	t.Helper()
	resolve := func(id string) (string, bool) { return "/tmp/" + id + ".mp4", true }
	plan, err := Compile(doc, resolve, "/tmp/o.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	return strings.Join(plan.Args, " ")
}

// TestAnchorFracDefaultsToCenter pins the migration guarantee: the zero value of
// the anchor fields — which is what every document written before anchors
// existed decodes to — must mean "center", not "top-left".
func TestAnchorFracDefaultsToCenter(t *testing.T) {
	ax, ay := schema.Transform{}.AnchorFrac()
	if ax != 0.5 || ay != 0.5 {
		t.Fatalf("zero anchor = (%v,%v), want center (0.5,0.5)", ax, ay)
	}
	// ±0.5 is an edge, and beyond that clamps rather than flying off-canvas.
	if ax, ay := (schema.Transform{AnchorX: -0.5, AnchorY: 0.5}).AnchorFrac(); ax != 0 || ay != 1 {
		t.Fatalf("edge anchor = (%v,%v), want (0,1)", ax, ay)
	}
	if ax, ay := (schema.Transform{AnchorX: -9, AnchorY: 9}).AnchorFrac(); ax != 0 || ay != 1 {
		t.Fatalf("out-of-range anchor = (%v,%v), want clamped (0,1)", ax, ay)
	}
}

// TestAnchorMovesStaticPosition checks the anchor actually relocates a scaled
// clip: at half scale on a 640x360 canvas the box is 320x180, so a centered
// anchor puts it at (160,90) and a top-left anchor at (0,0).
func TestAnchorMovesStaticPosition(t *testing.T) {
	centered := compileArgs(t, oneClipDoc(schema.Transform{Scale: 0.5, Opacity: 1}, nil))
	if !strings.Contains(centered, "overlay=x=160:y=90") {
		t.Errorf("centered anchor should overlay at 160,90; got:\n%s", centered)
	}
	topLeft := compileArgs(t, oneClipDoc(
		schema.Transform{Scale: 0.5, Opacity: 1, AnchorX: -0.5, AnchorY: -0.5}, nil))
	if !strings.Contains(topLeft, "overlay=x=0:y=0") {
		t.Errorf("top-left anchor should overlay at 0,0; got:\n%s", topLeft)
	}
}

// TestAnchorDrivesAnimatedScaleOrigin is the one that matters for tutorial
// zooms. When scale is keyframed the box size changes per frame, so position
// switches to an expression over overlay's live w/h — and that expression has to
// carry the anchor, or every zoom silently snaps back to the middle.
func TestAnchorDrivesAnimatedScaleOrigin(t *testing.T) {
	kf := map[string][]schema.Keyframe{"scale": {{T: 0, Value: 1}, {T: 3, Value: 2}}}

	centered := compileArgs(t, oneClipDoc(schema.Transform{Scale: 1, Opacity: 1}, kf))
	if !strings.Contains(centered, "0.5000*(W-w)") {
		t.Errorf("animated scale should anchor at 0.5*(W-w); got:\n%s", centered)
	}
	corner := compileArgs(t, oneClipDoc(
		schema.Transform{Scale: 1, Opacity: 1, AnchorX: 0.25, AnchorY: -0.5}, kf))
	if !strings.Contains(corner, "0.7500*(W-w)") || !strings.Contains(corner, "0.0000*(H-h)") {
		t.Errorf("anchored zoom should use 0.75*(W-w) / 0*(H-h); got:\n%s", corner)
	}
}

// TestRotationKeyframesCompile confirms animated rotation emits a per-frame
// angle expression sized to the diagonal. ow/oh are evaluated once at config
// time, so they cannot track the live angle — a diagonal box is what keeps the
// corners from being clipped mid-spin.
func TestRotationKeyframesCompile(t *testing.T) {
	args := compileArgs(t, oneClipDoc(schema.Transform{Scale: 1, Opacity: 1},
		map[string][]schema.Keyframe{"rotation": {{T: 0, Value: 0, Ease: "linear"}, {T: 3, Value: 360}}}))

	if !strings.Contains(args, "rotate=a=") {
		t.Errorf("rotation keyframes should emit an animated rotate; got:\n%s", args)
	}
	if !strings.Contains(args, "hypot(iw,ih)") {
		t.Errorf("animated rotation should size the box to the diagonal; got:\n%s", args)
	}
	// Degrees in the document, radians in the filter.
	if !strings.Contains(args, "0.0174532925") {
		t.Errorf("rotation should be converted to radians; got:\n%s", args)
	}
	// A rotating box changes size, so position must track overlay's live w/h.
	if !strings.Contains(args, "(W-w)") {
		t.Errorf("animated rotation should position dynamically; got:\n%s", args)
	}
}

// TestStaticRotationStillExact makes sure adding the animated path didn't
// regress static rotation onto the coarser diagonal box.
func TestStaticRotationStillExact(t *testing.T) {
	args := compileArgs(t, oneClipDoc(schema.Transform{Scale: 1, Opacity: 1, Rotation: 30}, nil))
	if !strings.Contains(args, "ow=rotw(") {
		t.Errorf("static rotation should keep the exact rotw/roth box; got:\n%s", args)
	}
	if strings.Contains(args, "hypot(iw,ih)") {
		t.Errorf("static rotation should not use the diagonal box; got:\n%s", args)
	}
}

// TestAnchoredZoomAndRotationRun is the end-to-end check: ffmpeg has to actually
// accept and render the graph, since a malformed expression only surfaces there.
func TestAnchoredZoomAndRotationRun(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "green")

	doc := oneClipDoc(
		schema.Transform{Scale: 1, Opacity: 1, AnchorX: 0.3, AnchorY: -0.2},
		map[string][]schema.Keyframe{
			"scale":    {{T: 0, Value: 1, Ease: "easeInOut"}, {T: 3, Value: 2}},
			"rotation": {{T: 0, Value: 0, Ease: "easeOutBack"}, {T: 3, Value: 45}},
		})
	resolve := func(string) (string, bool) { return src, true }

	out := filepath.Join(dir, "out.mp4")
	plan, err := Compile(doc, resolve, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\nargs: %v\n%s", err, plan.Args, b)
	}
	if fi, err := os.Stat(out); err != nil || fi.Size() == 0 {
		t.Fatalf("no output produced: %v", err)
	}
}
