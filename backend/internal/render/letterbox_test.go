package render

import (
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

/*
A letterboxed clip that is zoomed and panned within its limits stays covered.

FitAuto used to fill on any clip the camera was working, because a letterboxed
picture that is pushed into would otherwise slide its own transparent bar
through frame. Dropping that guard is safe because the thing that EMITS a camera
move clamps it to the picture rather than to the frame — see fillsFrame and
centerOffsetIn in zoomPan.ts, and the test beside them.

So the limit here is the real one. At scale 1.6 a 480-wide picture is 768 wide
in a 640 frame, which leaves 64px of travel each way; the pan is keyed to
exactly that. The renderer plays keyframes back and does not clamp them itself,
so a keyframe written past this limit WOULD expose background — nothing in the
UI writes one, and that is the guarantee, stated honestly rather than assumed.
*/
func TestLetterboxedClipNeverPansOffItsOwnPicture(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	const W, H = 640, 360

	// 4:3 into 16:9 — letterboxed by the new default, with 80px bars each side.
	src := filepath.Join(dir, "narrow.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=0x808080:s=480x360:r=24:d=6",
		"-frames:v", "144", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}

	kf := map[string][]schema.Keyframe{
		"scale": {
			{T: 0, Value: 1, Ease: "easeInOut"},
			{T: 1, Value: 1.6, Ease: "linear"},
			{T: 4, Value: 1.6, Ease: "easeInOut"},
			{T: 5, Value: 1.6, Ease: "linear"},
		},
		"x": {
			{T: 0, Value: 0, Ease: "easeInOut"},
			// 64px each way is what a 768-wide picture can give a 640 frame at
			// this scale — the number centerOffsetIn arrives at.
			{T: 1, Value: 64, Ease: "linear"},
			{T: 4, Value: -64, Ease: "easeInOut"},
			{T: 5, Value: -64, Ease: "linear"},
		},
	}
	doc := &schema.EditDoc{
		// A document written since the change: FitAuto means letterbox, and the
		// migration must leave it alone. Without the stamp this clip's zoom
		// keyframes would be read as "this was being filled" and migrated to
		// fill — which is how the first version of this test found no letterbox.
		SchemaRev: schema.FitSchemaRev,
		Canvas:    schema.Canvas{Width: W, Height: H, FPS: 24},
		// The renderer learns a source's shape from the asset list, not by
		// probing the file — without this the clip has no known shape, the
		// prefit is skipped entirely, and the picture is simply stretched.
		Assets: []schema.Asset{{ID: "a", Kind: "video", Width: 480, Height: 360, Duration: 6}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#ff00ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 5,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Keyframes: kf,
				// FitAuto, deliberately: this is the default's behaviour under
				// test, not an explicitly letterboxed clip's.
			}}},
		},
	}

	// At rest the bars are exactly what letterboxing means, and they are the
	// budget: 4:3 in 16:9 leaves 80px each side.
	baseline := countMagenta(t, renderFrame(t, doc, src, dir, 0.1))
	if baseline < 40000 || baseline > 70000 {
		t.Fatalf("baseline letterbox is %d px, not the ~57600 two 80px bars make — "+
			"the clip is not being letterboxed and the test proves nothing", baseline)
	}

	// Scale 1.6 on a 480-wide picture is 768 wide, which covers a 640 frame
	// completely. So once the push-in has finished there must be no background
	// at all, however far the pan has been asked to travel.
	for _, at := range []float64{1.1, 1.5, 2.0, 2.8, 3.5, 3.9, 4.1, 4.6} {
		if n := countMagenta(t, renderFrame(t, doc, src, dir, at)); n > 0 {
			t.Errorf("t=%.2f: %d background pixels — the pan ran off the picture", at, n)
		}
	}

	// And on the way in, the bars only ever shrink. A frame showing MORE
	// background than the resting one would mean the camera had pushed the
	// picture away from the frame rather than into it.
	for _, at := range []float64{0.3, 0.6, 0.9} {
		if n := countMagenta(t, renderFrame(t, doc, src, dir, at)); n > baseline {
			t.Errorf("t=%.2f: %d background pixels, more than the %d at rest", at, n, baseline)
		}
	}
}

// The other half of the same promise: an explicitly filled clip still fills, so
// nothing that asked to be cropped stopped being cropped.
func TestExplicitFillStillCoversTheFrame(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "narrow.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=0x808080:s=480x360:r=24:d=3",
		"-frames:v", "72", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}
	doc := &schema.EditDoc{
		SchemaRev: schema.FitSchemaRev,
		Canvas:    schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Assets:    []schema.Asset{{ID: "a", Kind: "video", Width: 480, Height: 360, Duration: 3}},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#ff00ff"},
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 3,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Fit:       schema.FitCover,
			}}},
		},
	}
	if n := countMagenta(t, renderFrame(t, doc, src, dir, 1.0)); n > 0 {
		t.Errorf("an explicitly filled clip left %d background pixels", n)
	}
}

/*
Which part of an overflowing picture survives is a choice, and it is made here.

A filled clip crops to the middle, which is the right answer only when the
subject happens to be in the middle — and on a screen recording it usually is
not. The proof has to be in pixels: a source with a distinctly coloured left
third, middle third and right third, filled into a narrower frame, and then the
question of which third came out.
*/
func TestFillFocusChoosesWhatSurvives(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()

	// 900x360 in three 300-wide bands: red | grey | blue.
	src := filepath.Join(dir, "bands.mp4")
	cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=red:s=300x360:r=24:d=3",
		"-f", "lavfi", "-i", "color=c=0x808080:s=300x360:r=24:d=3",
		"-f", "lavfi", "-i", "color=c=blue:s=300x360:r=24:d=3",
		"-filter_complex", "[0:v][1:v][2:v]hstack=inputs=3[v]",
		"-map", "[v]", "-frames:v", "72", "-pix_fmt", "yuv420p", src)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build source: %v\n%s", err, b)
	}

	// A 640x360 frame is 260px narrower than the 900-wide source once fitted by
	// height, so there is real overflow to choose from.
	frameFor := func(focusX float64) string {
		doc := &schema.EditDoc{
			SchemaRev: schema.FitSchemaRev,
			Canvas:    schema.Canvas{Width: 640, Height: 360, FPS: 24},
			Assets:    []schema.Asset{{ID: "a", Kind: "video", Width: 900, Height: 360, Duration: 3}},
			Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c", AssetID: "a", Start: 0, In: 0, Out: 3,
				Transform:  schema.Transform{Scale: 1, Opacity: 1},
				Fit:        schema.FitCover,
				FillFocusX: focusX,
			}}}},
		}
		return renderFrame(t, doc, src, dir, 1.0)
	}

	/*
	 * The numbers are exact, so they are asserted exactly.
	 *
	 * Fitted by height the source stays 900 wide, so a 640 frame crops 260px.
	 * At focus 0 the window is x=0..640 and holds all 300px of red; centred it
	 * is 130..770 and holds 170; hard right it is 260..900 and still holds 40,
	 * because the red band reaches x=300. That last sliver is why "no red at
	 * all" is the wrong assertion — an earlier version made it and failed
	 * against perfectly correct output.
	 */
	const rows = 360
	for _, c := range []struct {
		name   string
		focus  float64
		wantPx int
	}{
		{"hard left", -0.5, 300 * rows},
		{"centred", 0, 170 * rows},
		{"hard right", 0.5, 40 * rows},
	} {
		_, _, got := redCentroid(t, frameFor(c.focus))
		// A band edge blurs by a pixel or two through the encoder.
		if diff := got - c.wantPx; diff > 3*rows || diff < -3*rows {
			t.Errorf("%s kept %d red px, want about %d", c.name, got, c.wantPx)
		}
	}
}
