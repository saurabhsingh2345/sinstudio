package render

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// writeTrack drops a pointer track beside a media file, the way ingest does.
func writeTrack(t *testing.T, mediaPath string, vw, vh int, samples []cursor.Sample) {
	t.Helper()
	var tr cursor.Track
	tr.Version = 1
	tr.Clicks = true
	tr.Video.Width, tr.Video.Height = vw, vh
	tr.Samples = samples
	b, err := json.Marshal(&tr)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cursor.Path(mediaPath), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func cursorDoc(fx *schema.CursorFX) *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			Cursor:    fx,
		}}}},
	}
}

// A moving pointer with a click partway through.
func samplePath() []cursor.Sample {
	out := []cursor.Sample{}
	for i := 0; i <= 30; i++ {
		s := cursor.Sample{T: int64(i * 100), X: 20 + i*20, Y: 20 + i*10}
		if i == 15 {
			s.Down = cursor.ButtonLeft
		}
		out = append(out, s)
	}
	return out
}

func TestCursorFXIsInertWithoutATrack(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue") // deliberately no sidecar

	doc := cursorDoc(&schema.CursorFX{Highlight: &schema.CursorHighlight{}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(dir, "o.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if strings.Contains(strings.Join(plan.Args, " "), "sendcmd") {
		t.Error("a clip with no pointer track should compile no cursor effects")
	}
}

// Position has to be driven by a flat command list, not a nested expression:
// a pointer track has thousands of samples and kfExpr nests one if() per point.
func TestCursorHighlightUsesSendcmdNotNestedExpressions(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")
	writeTrack(t, src, 640, 360, samplePath())

	doc := cursorDoc(&schema.CursorFX{Highlight: &schema.CursorHighlight{Size: 80}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(dir, "o.mp4"), dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	joined := strings.Join(plan.Args, " ")
	if !strings.Contains(joined, "sendcmd=f=") {
		t.Fatalf("expected a sendcmd script; got:\n%s", joined)
	}
	if !strings.Contains(joined, "overlay@hl0") {
		t.Fatalf("expected a named overlay instance for the highlight; got:\n%s", joined)
	}

	cmdPath := filepath.Join(dir, "cursor.cmd")
	body, err := os.ReadFile(cmdPath)
	if err != nil {
		t.Fatalf("no command script written: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	if len(lines) < 10 {
		t.Errorf("expected a command per sample, got %d lines", len(lines))
	}
	// sendcmd requires ascending times.
	for i := 1; i < len(lines); i++ {
		if cmdTime(lines[i]) < cmdTime(lines[i-1]) {
			t.Fatalf("commands out of order at line %d:\n%s\n%s", i, lines[i-1], lines[i])
		}
	}
}

// A press held across many samples is one click. Drawing a ring per sample
// would strobe rather than read as a click.
func TestClickRingsFireOnPressEdgesOnly(t *testing.T) {
	held := []cursor.Sample{
		{T: 0, X: 10, Y: 10},
		{T: 100, X: 10, Y: 10, Down: cursor.ButtonLeft},
		{T: 200, X: 10, Y: 10, Down: cursor.ButtonLeft},
		{T: 300, X: 10, Y: 10, Down: cursor.ButtonLeft},
		{T: 400, X: 10, Y: 10},
		{T: 500, X: 10, Y: 10, Down: cursor.ButtonLeft},
	}
	var tr cursor.Track
	tr.Samples = held
	got := tr.ClickTimes()
	if len(got) != 2 {
		t.Fatalf("held press produced %d clicks, want 2 (one per press edge): %v", len(got), got)
	}
	if got[0] != 0.1 || got[1] != 0.5 {
		t.Errorf("click times = %v, want [0.1 0.5]", got)
	}
}

func TestTrackAtInterpolatesAndHolds(t *testing.T) {
	var tr cursor.Track
	tr.Samples = []cursor.Sample{{T: 0, X: 0, Y: 0}, {T: 1000, X: 100, Y: 200}}

	if x, y := tr.At(-5); x != 0 || y != 0 {
		t.Errorf("before the first sample = (%d,%d), want the first value", x, y)
	}
	if x, y := tr.At(0.5); x != 50 || y != 100 {
		t.Errorf("midpoint = (%d,%d), want (50,100)", x, y)
	}
	if x, y := tr.At(99); x != 100 || y != 200 {
		t.Errorf("after the last sample = (%d,%d), want the last value", x, y)
	}
}

// Pointer coordinates are in the recording's pixel space. A 4K capture placed
// on a 1080p canvas must have its path scaled with it, or every highlight lands
// off-screen.
func TestCursorCoordinatesScaleToCanvas(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")
	// Track recorded at 1280x720; canvas is 640x360, so everything halves.
	writeTrack(t, src, 1280, 720, []cursor.Sample{
		{T: 0, X: 400, Y: 200},
		{T: 1000, X: 800, Y: 400},
	})

	doc := cursorDoc(&schema.CursorFX{Highlight: &schema.CursorHighlight{Size: 40}})
	if _, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(dir, "o.mp4"), dir, Options{}); err != nil {
		t.Fatalf("compile: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "cursor.cmd"))
	if err != nil {
		t.Fatal(err)
	}
	// 400 → 200 canvas px, minus half the 40px disc = 180.
	if !strings.Contains(string(body), "x 180") {
		t.Errorf("expected the path scaled to canvas space; got:\n%s", body)
	}
}

// The real check: ffmpeg has to accept and render the graph. A malformed
// sendcmd script or a bad overlay name only surfaces here.
func TestCursorEffectsRender(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "green")
	writeTrack(t, src, 640, 360, samplePath())

	doc := cursorDoc(&schema.CursorFX{
		Highlight: &schema.CursorHighlight{Size: 80},
		Clicks:    &schema.CursorClicks{Size: 120},
		Spotlight: &schema.CursorSpotlight{Radius: 120, Dim: 0.6},
	})
	out := filepath.Join(dir, "out.mp4")
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
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

// Each effect renders on its own, so a failure names the culprit instead of
// leaving "cursor effects are broken".
func TestEachCursorEffectRendersAlone(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	cases := map[string]*schema.CursorFX{
		"highlight": {Highlight: &schema.CursorHighlight{Size: 80}},
		"clicks":    {Clicks: &schema.CursorClicks{Size: 120}},
		"spotlight": {Spotlight: &schema.CursorSpotlight{Radius: 120, Dim: 0.6}},
	}
	for name, fx := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			src := filepath.Join(dir, "a.mp4")
			makeTestClip(t, src, "green")
			writeTrack(t, src, 640, 360, samplePath())
			out := filepath.Join(dir, "out.mp4")
			plan, err := Compile(cursorDoc(fx), func(string) (string, bool) { return src, true }, out, dir, Options{})
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
				t.Fatalf("ffmpeg failed: %v\n%s", err, lastLines(string(b), 6))
			}
		})
	}
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// Renders a highlight following a known path and checks the bright disc is
// actually where the pointer was — the effects existing is not the same as the
// effects being in the right place.
func TestHighlightLandsOnThePointer(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	// Pointer parked at a known spot for the whole clip.
	writeTrack(t, src, 640, 360, []cursor.Sample{
		{T: 0, X: 160, Y: 90}, {T: 2900, X: 160, Y: 90},
	})
	doc := cursorDoc(&schema.CursorFX{Highlight: &schema.CursorHighlight{
		Size: 80, Color: "#ff0000", Opacity: 1,
	}})
	out := filepath.Join(dir, "f.png")
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir,
		Options{FrameAt: 1.5})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, b)
	}
	x, y, n := redCentroid(t, out)
	if n == 0 {
		t.Fatal("no highlight rendered")
	}
	if x < 150 || x > 170 || y < 80 || y > 100 {
		t.Errorf("highlight at (%.1f,%.1f), want the pointer at (160,90)", x, y)
	}
}
