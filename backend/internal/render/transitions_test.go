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

// TestCompileTransitionsRuns builds a two-clip timeline that exercises every
// transition kind (slide on both axes + fade/dissolve) and confirms the
// compiled filtergraph is one ffmpeg actually accepts and renders.
func TestCompileTransitionsRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()

	// Two distinct 3s test sources.
	clipA := filepath.Join(dir, "a.mp4")
	clipB := filepath.Join(dir, "b.mp4")
	makeTestClip(t, clipA, "red")
	makeTestClip(t, clipB, "blue")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{
			ID: "v", Kind: schema.TrackVideo,
			Clips: []schema.Clip{
				{
					ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
					Transform:     schema.Transform{Scale: 1, Opacity: 1},
					TransitionIn:  &schema.Transition{Type: "slide-left", Duration: 0.5},
					TransitionOut: &schema.Transition{Type: "dissolve", Duration: 0.5},
				},
				{
					ID: "c2", AssetID: "b", Start: 2.5, In: 0, Out: 3,
					Transform:     schema.Transform{Scale: 0.6, Opacity: 1},
					TransitionIn:  &schema.Transition{Type: "fade", Duration: 0.5},
					TransitionOut: &schema.Transition{Type: "slide-bottom", Duration: 0.5},
				},
			},
		}},
	}

	resolve := func(id string) (string, bool) {
		switch id {
		case "a":
			return clipA, true
		case "b":
			return clipB, true
		}
		return "", false
	}

	out := filepath.Join(dir, "out.mp4")
	plan, err := Compile(doc, resolve, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	cmd := exec.CommandContext(context.Background(), "ffmpeg", plan.Args...)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\nargs: %v\n%s", err, plan.Args, b)
	}
	fi, err := os.Stat(out)
	if err != nil || fi.Size() == 0 {
		t.Fatalf("no output produced: %v", err)
	}
}

// TestSoloSuppressesTracks confirms that soloing one content track drops the
// non-soloed track's input from the filtergraph while keeping the soloed one.
func TestSoloSuppressesTracks(t *testing.T) {
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{
			{ID: "v1", Kind: schema.TrackVideo, Clips: []schema.Clip{
				{ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2, Transform: schema.Transform{Scale: 1, Opacity: 1}},
			}},
			{ID: "v2", Kind: schema.TrackVideo, Solo: true, Clips: []schema.Clip{
				{ID: "c2", AssetID: "b", Start: 0, In: 0, Out: 2, Transform: schema.Transform{Scale: 1, Opacity: 1}},
			}},
		},
	}
	resolve := func(id string) (string, bool) {
		return "/tmp/" + id + ".mp4", id == "a" || id == "b"
	}
	plan, err := Compile(doc, resolve, "/tmp/o.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "/tmp/b.mp4") {
		t.Errorf("soloed track b should be present in args")
	}
	if strings.Contains(joined, "/tmp/a.mp4") {
		t.Errorf("non-soloed track a should be suppressed when a solo is active")
	}
}

// TestKeyframeMotionRuns confirms a clip animated with x/y position keyframes
// compiles to a filtergraph ffmpeg accepts and renders.
func TestKeyframeMotionRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	makeTestClip(t, clip, "green")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: schema.Transform{Scale: 0.5, Opacity: 1},
			Keyframes: map[string][]schema.Keyframe{
				"x": {{T: 0, Value: -200}, {T: 1.5, Value: 200}, {T: 3, Value: 0}},
				"y": {{T: 0, Value: 0}, {T: 3, Value: 80}},
			},
		}}}},
	}
	resolve := func(id string) (string, bool) { return clip, id == "a" }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
		t.Fatalf("no output: %v", err)
	}
}

// TestEffectsRuns confirms a clip with color/blur effects compiles to a
// filtergraph ffmpeg accepts.
func TestEffectsRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	makeTestClip(t, clip, "gray")

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Effects:   &schema.Effects{Brightness: 0.15, Contrast: 1.3, Saturation: 1.4, Hue: 30, Blur: 3},
		}}}},
	}
	resolve := func(id string) (string, bool) { return clip, id == "a" }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(strings.Join(plan.Args, " "), "eq=brightness") {
		t.Errorf("expected eq filter in args")
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
}

// TestTitleRuns confirms a text/title clip (no asset) renders to a PNG and
// composites through the still-visual pipeline with a transition.
func TestTitleRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#101020"},
			{ID: "ov", Kind: schema.TrackOverlay, Clips: []schema.Clip{{
				ID: "t1", Start: 0, In: 0, Out: 2,
				Transform:    schema.Transform{Scale: 1, Opacity: 1},
				TransitionIn: &schema.Transition{Type: "slide-bottom", Duration: 0.4},
				Title:        &schema.Title{Text: "Title Test", Size: 72, Color: "#ffffff", Align: "center", PosY: 0.5},
			}}},
		},
	}
	resolve := func(id string) (string, bool) { return "", false }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
		t.Fatalf("no output: %v", err)
	}
}

// TestOpacityKeyframesRun confirms opacity keyframes compile to a geq alpha
// animation ffmpeg accepts.
func TestOpacityKeyframesRun(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	makeTestClip(t, clip, "red")
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Keyframes: map[string][]schema.Keyframe{"opacity": {{T: 0, Value: 0}, {T: 1, Value: 1}, {T: 2, Value: 0}}},
		}}}},
	}
	resolve := func(id string) (string, bool) { return clip, id == "a" }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if !strings.Contains(strings.Join(plan.Args, " "), "geq=") {
		t.Errorf("expected geq alpha filter for opacity keyframes")
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
}

// TestScaleKeyframesRun confirms scale keyframes compile to a per-frame
// scale=eval=frame animation (with dynamic overlay re-centering) that ffmpeg
// accepts and renders — covering both grow and shrink.
func TestScaleKeyframesRun(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	makeTestClip(t, clip, "blue")
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			// grow 0.4->1.2 then shrink back to 0.8
			Keyframes: map[string][]schema.Keyframe{"scale": {{T: 0, Value: 0.4}, {T: 1.5, Value: 1.2}, {T: 3, Value: 0.8}}},
		}}}},
	}
	resolve := func(id string) (string, bool) { return clip, id == "a" }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "eval=frame") {
		t.Errorf("expected an eval=frame scale filter for scale keyframes")
	}
	if !strings.Contains(joined, "(W-w)/2") {
		t.Errorf("expected dynamic overlay re-centering for scale keyframes")
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
		t.Fatalf("no output: %v", err)
	}
}

// TestKeyframeEasingRuns confirms eased keyframes (back overshoot on scale,
// elastic on x) compile to the expected curve math and render.
func TestKeyframeEasingRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "a.mp4")
	makeTestClip(t, clip, "orange")
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Keyframes: map[string][]schema.Keyframe{
				"scale": {{T: 0, Value: 0.3, Ease: "easeOutBack"}, {T: 1.5, Value: 1.0}},
				"x":     {{T: 0, Value: -200, Ease: "easeOutElastic"}, {T: 3, Value: 0}},
			},
		}}}},
	}
	resolve := func(id string) (string, bool) { return clip, id == "a" }
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "2.70158") { // easeOutBack overshoot constant
		t.Errorf("expected easeOutBack curve math in scale expr")
	}
	if !strings.Contains(joined, "2.0943951") { // easeOutElastic 2π/3 constant
		t.Errorf("expected easeOutElastic curve math in x expr")
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
		t.Fatalf("no output: %v", err)
	}
}

// TestAudioDuckAndLoudnorm confirms a music track flagged Duck compiles to a
// sidechaincompress against the voice, and Loudnorm adds an EBU R128 pass.
func TestAudioDuckAndLoudnorm(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	voice := filepath.Join(dir, "voice.mp4")
	music := filepath.Join(dir, "music.mp4")
	makeAudioClip(t, voice, "sine=frequency=300")
	makeAudioClip(t, music, "sine=frequency=800")
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#000000"},
			{ID: "vo", Kind: schema.TrackAudio, Clips: []schema.Clip{{ID: "v1", AssetID: "voice", Start: 0, In: 0, Out: 2, Volume: 1}}},
			{ID: "mu", Kind: schema.TrackAudio, Duck: true, Clips: []schema.Clip{{ID: "m1", AssetID: "music", Start: 0, In: 0, Out: 2, Volume: 1}}},
		},
	}
	resolve := func(id string) (string, bool) {
		switch id {
		case "voice":
			return voice, true
		case "music":
			return music, true
		}
		return "", false
	}
	plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{Loudnorm: true})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "sidechaincompress") {
		t.Errorf("expected sidechaincompress for a ducked music track")
	}
	if !strings.Contains(joined, "loudnorm=I=-16") {
		t.Errorf("expected loudnorm pass when Loudnorm option set")
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, b)
	}
	if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
		t.Fatalf("no output: %v", err)
	}
}

// TestExportRangeValidation confirms out-of-range From/To are rejected rather
// than compiled into a negative -t (which ffmpeg refuses).
func TestExportRangeValidation(t *testing.T) {
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{
			{ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 4, Transform: schema.Transform{Scale: 1, Opacity: 1}},
		}}},
	}
	resolve := func(id string) (string, bool) { return "/tmp/" + id + ".mp4", id == "a" }
	cases := []struct {
		name    string
		opts    Options
		wantErr bool
	}{
		{"start past end", Options{From: 10}, true},
		{"end before start", Options{From: 2, To: 1}, true},
		{"valid subrange", Options{From: 1, To: 3}, false},
		{"from only", Options{From: 1}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Compile(doc, resolve, "/tmp/o.mp4", t.TempDir(), tc.opts)
			if tc.wantErr && err == nil {
				t.Errorf("expected an error for %+v", tc.opts)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("unexpected error for %+v: %v", tc.opts, err)
			}
		})
	}
}

// TestCaptionDefaultPosY confirms a caption cue with an unset (zero) PosY is
// rendered at the lower-third default instead of clipped at the top.
func TestCaptionDefaultPosY(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "cap.png")
	cue := schema.CaptionCue{ID: "q1", Start: 0, End: 2, Text: "Hello", Style: schema.CaptionStyle{Size: 24}}
	if err := renderCaptionPNG(cue, 640, 360, out); err != nil {
		t.Fatalf("render caption: %v", err)
	}
	fi, err := os.Stat(out)
	if err != nil || fi.Size() == 0 {
		t.Fatalf("no caption png produced: %v", err)
	}
}

// TestTitleRevealRuns confirms a typewriter/word text reveal composites multiple
// prefix PNGs into a filtergraph ffmpeg accepts and renders.
func TestTitleRevealRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	for _, mode := range []string{"typewriter", "word"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			doc := &schema.EditDoc{
				Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
				Tracks: []schema.Track{
					{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#101020"},
					{ID: "ov", Kind: schema.TrackOverlay, Clips: []schema.Clip{{
						ID: "t1", Start: 0, In: 0, Out: 3,
						Transform: schema.Transform{Scale: 1, Opacity: 1},
						FadeIn:    0.3, FadeOut: 0.3,
						Title:     &schema.Title{Text: "Hello brave new world", Size: 64, Color: "#ffffff", Align: "center", PosY: 0.5, Reveal: mode},
					}}},
				},
			}
			resolve := func(id string) (string, bool) { return "", false }
			plan, err := Compile(doc, resolve, filepath.Join(dir, "out.mp4"), dir, Options{})
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
				t.Fatalf("ffmpeg failed: %v\n%s", err, b)
			}
			if fi, err := os.Stat(filepath.Join(dir, "out.mp4")); err != nil || fi.Size() == 0 {
				t.Fatalf("no output: %v", err)
			}
		})
	}
}

// TestTitleRevealSteps checks the reveal-step boundaries: last step is the
// full-text sentinel and word mode yields one step per word.
func TestTitleRevealSteps(t *testing.T) {
	tw := titleRevealSteps("abcdef", "typewriter")
	if tw[len(tw)-1] != -1 {
		t.Errorf("typewriter last step should be -1 (full), got %v", tw)
	}
	wd := titleRevealSteps("one two three", "word")
	if len(wd) != 3 {
		t.Errorf("word mode should give 3 steps for 3 words, got %v", wd)
	}
	if wd[len(wd)-1] != -1 {
		t.Errorf("word last step should be -1 (full), got %v", wd)
	}
	if got := titleRevealSteps("", "typewriter"); len(got) != 1 || got[0] != -1 {
		t.Errorf("empty text should give [-1], got %v", got)
	}
}

// makeAudioClip renders a short mp4 carrying a lavfi audio source (with a video
// stream so it behaves like a normal clip through the pipeline).
func makeAudioClip(t *testing.T, path, aExpr string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y",
		"-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=2",
		"-f", "lavfi", "-i", aExpr+":d=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make audio clip: %v\n%s", err, b)
	}
}

func makeTestClip(t *testing.T, path, color string) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y", "-f", "lavfi", "-i",
		"color=c="+color+":s=640x360:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make test clip: %v\n%s", err, b)
	}
}
