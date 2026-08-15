package render

import (
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// TestClickDipGolden pins the curve. cursor-draw.test.ts asserts the same
// numbers — a press the preview shows at one depth and the export at another is
// two different videos.
func TestClickDipGolden(t *testing.T) {
	clicks := []float64{1.0}
	cases := []struct {
		t    float64
		want float64
	}{
		{0.5, 1},     // before
		{1.0, 1},     // the instant of the press, before any travel
		{1.06, 0.72}, // fully pressed: 1 - 1.0*clickDipMax
		{0.99, 1},    // a frame earlier, untouched
		{1.32, 1},    // settled
		{5.0, 1},     // long after
	}
	for _, c := range cases {
		if got := pointerClickScale(clicks, c.t, 1); math.Abs(got-c.want) > 1e-6 {
			t.Errorf("scale(%.2f) = %.6f, want %.6f", c.t, got, c.want)
		}
	}
}

func TestClickDipIsOffWhenNotAsked(t *testing.T) {
	if got := pointerClickScale([]float64{1}, 1.06, 0); got != 1 {
		t.Errorf("amount 0 still dipped: %v", got)
	}
	if got := pointerClickScale(nil, 1.06, 1); got != 1 {
		t.Errorf("no clicks still dipped: %v", got)
	}
}

func TestClickDipStrengthScales(t *testing.T) {
	full := pointerClickScale([]float64{1}, 1.06, 1)
	half := pointerClickScale([]float64{1}, 1.06, 0.5)
	if math.Abs((1-half)-(1-full)/2) > 1e-9 {
		t.Errorf("half strength gave %.4f, not half the depth of %.4f", half, full)
	}
}

// The return leg overshoots — that is what makes the press feel sprung rather
// than merely animated. Sampling only at the endpoints would miss it entirely.
func TestClickDipSpringsBackPastItsOwnSize(t *testing.T) {
	var peak float64
	for t := 1.0; t < 1.4; t += 0.005 {
		if s := pointerClickScale([]float64{1}, t, 1); s > peak {
			peak = s
		}
	}
	if peak <= 1.0001 {
		t.Errorf("no overshoot on the way back: peak %.5f", peak)
	}
	if peak > 1.06 {
		t.Errorf("overshoot of %.3f is a bounce, not a spring", peak)
	}
}

func TestDensifyKeepsTheTrackHonest(t *testing.T) {
	// Two real samples 1s apart, with a press at the first.
	samples := []cursor.Sample{
		{T: 0, X: 0, Y: 0, Down: cursor.ButtonLeft},
		{T: 1000, X: 1000, Y: 500},
	}
	dense := densifyForClicks(samples, []float64{0})

	if len(dense) <= len(samples) {
		t.Fatalf("nothing was spliced in: %d points", len(dense))
	}
	for i := 1; i < len(dense); i++ {
		if dense[i].T < dense[i-1].T {
			t.Fatalf("out of order at %d: %v", i, dense[i-1:i+1])
		}
	}
	// THE trap: a spliced sample carrying a fresh zero between two pressed ones
	// reads as a release and then a second press, inventing a click in the data
	// every other effect keys off.
	before := (&cursor.Track{Samples: samples}).ClickTimes()
	after := (&cursor.Track{Samples: dense}).ClickTimes()
	if len(before) != len(after) {
		t.Fatalf("densifying changed the clicks: %v → %v", before, after)
	}
	// Positions must follow the same line Track.At reports, or the drawn cursor
	// steps off the path every other effect is placed on.
	tr := &cursor.Track{Samples: samples}
	for _, d := range dense {
		wx, wy := tr.At(float64(d.T) / 1000)
		if abs(d.X-wx) > 1 || abs(d.Y-wy) > 1 {
			t.Errorf("at %dms densified to (%d,%d), Track.At says (%d,%d)", d.T, d.X, d.Y, wx, wy)
		}
	}
}

func TestDensifyIsANoOpWithoutClicks(t *testing.T) {
	samples := []cursor.Sample{{T: 0, X: 0, Y: 0}, {T: 1000, X: 10, Y: 10}}
	if got := densifyForClicks(samples, nil); len(got) != len(samples) {
		t.Errorf("added %d points for no clicks", len(got)-len(samples))
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// The end-to-end check. A dip that scales the image but not the hotspot offset
// looks perfectly correct in every unit test and slides the cursor off the
// thing it just clicked, which is the one place it must not move.
func TestClickDipShrinksTheCursorWithoutMovingIt(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	// Parked, with a press at 1s. Parked on purpose: the dip has to be smooth
	// at the 250ms heartbeat rate, which is exactly when a click usually lands.
	var samples []cursor.Sample
	for ms := int64(0); ms <= 2900; ms += 250 {
		s := cursor.Sample{T: ms, X: 320, Y: 180}
		if ms == 1000 {
			s.Down = cursor.ButtonLeft
		}
		samples = append(samples, s)
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	// Rendered as a VIDEO, with frames pulled out of it afterwards, rather than
	// through Compile's single-frame path. A scale driven by sendcmd reconfigures
	// the filter for the FOLLOWING frame, so a one-frame grab lands on either
	// side of the change depending on where the seek falls — which made an
	// earlier version of this test pass five times and then fail. What ships is
	// the video; that is what to measure.
	out := filepath.Join(dir, "o.mp4")
	doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
		Size: 120, Color: "#ff0000", Opacity: 1, Style: "dot", ClickDip: 1,
	}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, lastLines(string(b), 10))
	}

	// Measured over the WHOLE press, not at one instant.
	//
	// The dip is a 0.3s curve and the frames are 42ms apart, so "the frame at
	// 1.06s" lands on either side of a steep change depending on rounding — an
	// earlier version of this test asserted there and flipped between passing
	// and failing on identical code. The dip's minimum over the window is a
	// property of the curve rather than of the frame grid, so that is what is
	// asserted.
	frames := func(from, to float64) []string {
		t.Helper()
		pat := filepath.Join(dir, fmt.Sprintf("s%.0f_%%03d.png", from*1000))
		if b, err := exec.Command("ffmpeg", "-y", "-loglevel", "error",
			"-ss", fmt.Sprintf("%.3f", from), "-to", fmt.Sprintf("%.3f", to),
			"-i", out, pat).CombinedOutput(); err != nil {
			t.Fatalf("extract %.2f..%.2f: %v\n%s", from, to, err, b)
		}
		got, err := filepath.Glob(filepath.Join(dir, fmt.Sprintf("s%.0f_*.png", from*1000)))
		if err != nil || len(got) == 0 {
			t.Fatalf("no frames extracted for %.2f..%.2f", from, to)
		}
		return got
	}

	// Resting: the cursor at full size, well before the press.
	_, _, restN := redCentroid(t, frames(0.4, 0.6)[0])
	if restN == 0 {
		t.Fatal("no cursor drawn before the click — the test proves nothing")
	}

	// Pressed: the smallest the cursor gets anywhere in the dip.
	//
	// Only the SIZE is asserted from the render. Whether the cursor stayed on
	// its own coordinate is checked in the command stream instead (see
	// TestClickDipKeepsTheHotspotOnThePointer) — ffmpeg applies an overlay's
	// position immediately and a scale's reconfiguration on the next frame, and
	// picking the smallest frame picks exactly the one where that skew is
	// largest. Measuring the centroid here would be measuring ffmpeg's
	// scheduling, and would fail identically whether the hotspot scaled or not.
	smallest := restN
	for _, f := range frames(1.0, 1.2) {
		if _, _, n := redCentroid(t, f); n < smallest {
			smallest = n
		}
	}
	if smallest >= int(float64(restN)*0.85) {
		t.Errorf("cursor did not visibly shrink on the press: %d px → %d px", restN, smallest)
	}
	// And it comes back to full size afterwards.
	var biggest int
	for _, f := range frames(1.5, 1.7) {
		if _, _, n := redCentroid(t, f); n > biggest {
			biggest = n
		}
	}
	if biggest < int(float64(restN)*0.9) {
		t.Errorf("cursor stayed small after the press: %d px, was %d px", biggest, restN)
	}
}

// The hotspot invariant, checked exactly where it is decided: every command that
// resizes the cursor must move it by the same proportion, or the cursor drifts
// off the pixel it is clicking. Read from the command stream rather than from
// pixels because it is a statement about numbers, and the render adds a frame of
// scheduling skew that has nothing to do with it.
func TestClickDipKeepsTheHotspotOnThePointer(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	var samples []cursor.Sample
	for ms := int64(0); ms <= 2900; ms += 250 {
		s := cursor.Sample{T: ms, X: 320, Y: 180}
		if ms == 1000 {
			s.Down = cursor.ButtonLeft
		}
		samples = append(samples, s)
	}
	writeTrackHidden(t, src, 640, 360, samples, true)

	doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
		Size: 120, Style: "dot", ClickDip: 1,
	}})
	if _, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(dir, "o.mp4"), dir, Options{}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "cursor.cmd"))
	if err != nil {
		t.Fatal(err)
	}

	// A dot centres its own hotspot, so the drawn centre is x + w/2. The pointer
	// never moves in this take, so that must always be (320,180).
	posRe := regexp.MustCompile(`overlay@\S+ x (-?\d+), overlay@\S+ y (-?\d+)`)
	sizeRe := regexp.MustCompile(`scale@\S+ w (\d+), scale@\S+ h (\d+)`)
	w, h := 0, 0
	checked := 0
	resized := false
	for _, line := range strings.Split(string(b), "\n") {
		pos := posRe.FindStringSubmatch(line)
		if pos == nil {
			continue
		}
		x, _ := strconv.Atoi(pos[1])
		y, _ := strconv.Atoi(pos[2])
		if sz := sizeRe.FindStringSubmatch(line); sz != nil {
			w, _ = strconv.Atoi(sz[1])
			h, _ = strconv.Atoi(sz[2])
		}
		if w == 0 {
			continue
		}
		if cx, cy := x+w/2, y+h/2; abs(cx-320) > 1 || abs(cy-180) > 1 {
			t.Errorf("at size %d the cursor centred on (%d,%d), want (320,180):\n  %s", w, cx, cy, line)
		}
		if w != 120 {
			resized = true
		}
		checked++
	}
	// Both guards exist because the assertion above passes vacuously on a dip
	// that never fired: every line would read x+w/2 == 320 at the authored size.
	if checked < 5 {
		t.Fatalf("only %d sized commands — the dip did not produce a ramp", checked)
	}
	if !resized {
		t.Error("the cursor was never resized, so the hotspot was never tested")
	}
}
