package render

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"studio/internal/schema"
)

// speedDoc is a 4s A/V timeline: enough length that a retime is unambiguous in
// the probed duration, and real audio so the atempo side of the graph is live.
func speedDoc() *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{{
			ID: "v", Kind: schema.TrackVideo,
			Clips: []schema.Clip{{
				ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 4,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}},
		}},
	}
}

// TestSpeedScalesOutputDuration is the contract of the export speed picker: an
// N× render is the same edit, 1/N as long. It walks both directions (slower and
// faster) and the >2× case that needs a chained atempo.
func TestSpeedScalesOutputDuration(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffmpeg/ffprobe not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeSpeedClip(t, src, 4)
	resolve := func(id string) (string, bool) { return src, id == "a" }

	for _, speed := range []float64{0.7, 1, 2, 8} {
		t.Run(fmt.Sprintf("%gx", speed), func(t *testing.T) {
			out := filepath.Join(dir, fmt.Sprintf("out-%g.mp4", speed))
			plan, err := Compile(speedDoc(), resolve, out, dir, Options{Speed: speed})
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if want := 4 / speed; !closeTo(plan.Dur, want, 0.05) {
				t.Errorf("plan duration = %.3f, want %.3f", plan.Dur, want)
			}
			if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
				t.Fatalf("ffmpeg failed: %v\nargs: %v\n%s", err, plan.Args, b)
			}
			got := probeDur(t, out)
			if want := 4 / speed; !closeTo(got, want, 0.25) {
				t.Errorf("rendered duration = %.3fs, want ~%.3fs", got, want)
			}
		})
	}
}

// TestSpeedGraphShape pins the two filters that do the work, and confirms 1x
// (and a frame grab at any speed) leave the graph exactly as it was — a speed
// picker nobody touched must not change a byte of the render.
func TestSpeedGraphShape(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	// A real A/V source: the compiler probes for an audio stream and drops the
	// audio half of the graph for a file that has none, atempo included.
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeSpeedClip(t, src, 4)
	resolve := func(id string) (string, bool) { return src, id == "a" }

	// 8x needs three chained atempos, because one only spans 0.5–2.0.
	plan, err := Compile(speedDoc(), resolve, filepath.Join(dir, "o.mp4"), dir, Options{Speed: 8})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	g := strings.Join(plan.Args, " ")
	if !strings.Contains(g, "setpts=PTS/8.000000") {
		t.Errorf("no whole-video setpts in graph:\n%s", g)
	}
	if n := strings.Count(g, "atempo=2.0000"); n < 3 {
		t.Errorf("8x needs 3 chained atempo=2, found %d:\n%s", n, g)
	}

	// Out of range: clamped, not rejected or passed to ffmpeg verbatim.
	plan, err = Compile(speedDoc(), resolve, filepath.Join(dir, "o.mp4"), dir, Options{Speed: 500})
	if err != nil {
		t.Fatalf("compile clamped: %v", err)
	}
	if !strings.Contains(strings.Join(plan.Args, " "), "setpts=PTS/10.000000") {
		t.Errorf("speed 500 should clamp to 10x")
	}

	// 1x, absent, and frame grabs: no retime filter at all.
	for _, tc := range []struct {
		name string
		opts Options
	}{
		{"one", Options{Speed: 1}},
		{"absent", Options{}},
		{"frame", Options{Speed: 4, FrameAt: 1}},
	} {
		plan, err := Compile(speedDoc(), resolve, filepath.Join(dir, "o.png"), dir, tc.opts)
		if err != nil {
			t.Fatalf("compile %s: %v", tc.name, err)
		}
		if g := strings.Join(plan.Args, " "); strings.Contains(g, "[vsp]") || strings.Contains(g, "[asp]") {
			t.Errorf("%s: expected no retime filters, got:\n%s", tc.name, g)
		}
	}
}

func closeTo(got, want, tol float64) bool { return got-want < tol && want-got < tol }

func probeDur(t *testing.T, path string) float64 {
	t.Helper()
	b, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration",
		"-of", "default=nw=1:nk=1", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	d, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	if err != nil {
		t.Fatalf("parse duration %q: %v", b, err)
	}
	return d
}

// makeSpeedClip renders an A/V test source: a moving pattern plus a tone, so a
// retime is visible in both streams.
func makeSpeedClip(t *testing.T, path string, dur float64) {
	t.Helper()
	cmd := exec.Command("ffmpeg", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("testsrc=s=320x180:r=24:d=%g", dur),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:d=%g", dur),
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("make speed clip: %v\n%s", err, b)
	}
}
