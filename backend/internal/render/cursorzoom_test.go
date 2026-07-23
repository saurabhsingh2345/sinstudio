package render

import (
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// parseCmdXY pulls the commanded x/y for a named overlay out of the script.
func parseCmdXY(t *testing.T, script, name string) map[float64][2]int {
	t.Helper()
	out := map[float64][2]int{}
	for _, line := range strings.Split(script, "\n") {
		if !strings.Contains(line, "overlay@"+name+" x ") {
			continue
		}
		ts := cmdTime(line)
		var x, y int
		for _, part := range strings.Split(strings.TrimSuffix(strings.TrimSpace(line), ";"), ",") {
			f := strings.Fields(strings.TrimSpace(part))
			if len(f) < 3 {
				continue
			}
			v, err := strconv.Atoi(f[len(f)-1])
			if err != nil {
				continue
			}
			switch f[len(f)-2] {
			case "x":
				x = v
			case "y":
				y = v
			}
		}
		out[ts] = [2]int{x, y}
	}
	return out
}

// Auto-zoom and cursor effects are the two headline features, and they have to
// compose. The overlays composite onto the canvas while the pointer's
// coordinates live in the recording's frame — a frame that moves and grows
// whenever the clip is zoomed. Position the overlays in flat canvas space and
// every highlight ends up on whatever content slid underneath it.
func TestCursorOverlaysFollowAZoomedClip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")
	// Pointer parked dead centre of a 640x360 recording for the whole clip.
	still := []cursor.Sample{{T: 0, X: 320, Y: 180}, {T: 2900, X: 320, Y: 180}}
	writeTrackHidden(t, src, 640, 360, still, false)

	const W, H = 640, 360
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: W, Height: H, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 3,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
			// Zoom to 2x while panning left, exactly what auto-zoom emits.
			Keyframes: map[string][]schema.Keyframe{
				"scale": {{T: 0, Value: 1, Ease: "linear"}, {T: 3, Value: 2}},
				"x":     {{T: 0, Value: 0, Ease: "linear"}, {T: 3, Value: -100}},
			},
			Cursor: &schema.CursorFX{Highlight: &schema.CursorHighlight{Size: 60}},
		}}}},
	}
	compileFor(t, doc, src, dir)

	body, err := os.ReadFile(filepath.Join(dir, "cursor.cmd"))
	if err != nil {
		t.Fatalf("no command script: %v", err)
	}
	cmds := parseCmdXY(t, string(body), "hl0")
	if len(cmds) < 2 {
		t.Fatalf("expected commands across the zoom, got %d", len(cmds))
	}

	// The pointer never moves, so anything the overlay does is the clip moving.
	// At scale s with pan p, centre-of-frame lands at 0.5*(W - W*s) + p + 0.5*W*s
	// = W/2 + p — and the highlight's top-left is that minus half its scaled size.
	check := func(ts float64) {
		got, ok := cmds[ts]
		if !ok {
			return
		}
		s := kfValueAt(doc.Tracks[0].Clips[0].Keyframes["scale"], ts)
		p := kfValueAt(doc.Tracks[0].Clips[0].Keyframes["x"], ts)
		wantX := int(float64(W)/2 + p - (60.0/2)*s)
		if math.Abs(float64(got[0]-wantX)) > 2 {
			t.Errorf("at t=%.2f highlight x = %d, want ~%d (scale %.2f, pan %.0f)", ts, got[0], wantX, s, p)
		}
	}
	var times []float64
	for ts := range cmds {
		times = append(times, ts)
	}
	for _, ts := range times {
		check(ts)
	}

	// And it must genuinely travel — a fixed position would satisfy nothing above
	// if the expectations were also fixed.
	var minX, maxX int = 1 << 30, -(1 << 30)
	for _, xy := range cmds {
		minX = min(minX, xy[0])
		maxX = max(maxX, xy[0])
	}
	if maxX-minX < 50 {
		t.Errorf("overlay barely moved (%d..%d) across a 2x zoom and a 100px pan", minX, maxX)
	}
}

// An unzoomed clip must be unaffected: the overlay stays put and keeps its
// authored size.
func TestCursorOverlaysAreStillForAnUnzoomedClip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "blue")
	writeTrackHidden(t, src, 640, 360, []cursor.Sample{{T: 0, X: 320, Y: 180}, {T: 2900, X: 320, Y: 180}}, false)

	doc := cursorDoc(&schema.CursorFX{Highlight: &schema.CursorHighlight{Size: 60}})
	compileFor(t, doc, src, dir)
	body, _ := os.ReadFile(filepath.Join(dir, "cursor.cmd"))
	cmds := parseCmdXY(t, string(body), "hl0")
	for ts, xy := range cmds {
		// 640x360 canvas, centred pointer, 60px disc → (320-30, 180-30).
		if xy[0] != 290 || xy[1] != 150 {
			t.Errorf("at t=%.2f overlay at %v, want [290 150]", ts, xy)
		}
	}
}
