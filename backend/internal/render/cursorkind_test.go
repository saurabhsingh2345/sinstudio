package render

import (
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// kindWalk builds a track whose cursor shape changes at the given times.
func kindWalk(changes map[int64]uint8, untilMS int64) []cursor.Sample {
	var out []cursor.Sample
	var k uint8
	for ms := int64(0); ms <= untilMS; ms += 50 {
		if nk, ok := changes[ms]; ok {
			k = nk
		}
		out = append(out, cursor.Sample{T: ms, X: 100, Y: 100, K: k})
	}
	return out
}

// A recording from a cursord that cannot report shapes — every sample zero —
// must compile to precisely what it always did: one arrow, one overlay.
func TestNoKindsMeansOneArrowSpan(t *testing.T) {
	s := kindWalk(nil, 3000)
	spans := cursorKindSpans(s, 0, 3)
	if len(spans) != 1 || spans[0].Kind != kindArrow {
		t.Fatalf("want one arrow span, got %+v", spans)
	}
	if spans[0].Start != 0 || spans[0].End != 3 {
		t.Errorf("span should cover the clip: %+v", spans[0])
	}
}

func TestKindSpansSplitOnShapeChanges(t *testing.T) {
	s := kindWalk(map[int64]uint8{0: kindArrow, 1000: kindHand, 2000: kindArrow}, 3000)
	spans := cursorKindSpans(s, 0, 3)
	if len(spans) != 3 {
		t.Fatalf("want three spans, got %+v", spans)
	}
	want := []struct {
		k    uint8
		a, b float64
	}{{kindArrow, 0, 1}, {kindHand, 1, 2}, {kindArrow, 2, 3}}
	for i, w := range want {
		if spans[i].Kind != w.k || math.Abs(spans[i].Start-w.a) > 1e-9 || math.Abs(spans[i].End-w.b) > 1e-9 {
			t.Errorf("span %d = %+v, want kind %d over %.1f..%.1f", i, spans[i], w.k, w.a, w.b)
		}
	}
}

// A pointer dragged across a row of links crosses in and out of the hand cursor
// several times a second. Following every one of those honestly is a strobe.
func TestKindSpansDoNotStrobe(t *testing.T) {
	changes := map[int64]uint8{}
	for ms := int64(0); ms < 3000; ms += 100 {
		if ms%200 == 0 {
			changes[ms] = kindHand
		} else {
			changes[ms] = kindArrow
		}
	}
	spans := cursorKindSpans(kindWalk(changes, 3000), 0, 3)
	if len(spans) > 2 {
		t.Errorf("a 10Hz flicker produced %d spans; it should collapse", len(spans))
	}
}

func TestKindSpansKeepASustainedShape(t *testing.T) {
	// Half a second on a hand is a deliberate hover, not a flicker.
	s := kindWalk(map[int64]uint8{1000: kindHand, 1500: kindArrow}, 3000)
	spans := cursorKindSpans(s, 0, 3)
	found := false
	for _, sp := range spans {
		if sp.Kind == kindHand {
			found = true
			if sp.End-sp.Start < 0.4 {
				t.Errorf("the hover was trimmed to %.2fs", sp.End-sp.Start)
			}
		}
	}
	if !found {
		t.Errorf("a half-second hover was dropped entirely: %+v", spans)
	}
}

func TestKindSpansAreClippedToTheClip(t *testing.T) {
	s := kindWalk(map[int64]uint8{0: kindArrow, 1000: kindHand}, 3000)
	spans := cursorKindSpans(s, 0.5, 2.0)
	for _, sp := range spans {
		if sp.Start < 0.5-1e-9 || sp.End > 2.0+1e-9 {
			t.Errorf("span %+v escapes the clip's 0.5..2.0 range", sp)
		}
	}
}

// Every shape has to carry its own hotspot, or the cursor points at the wrong
// pixel the moment it stops being an arrow.
func TestEveryShapeHasAPlausibleHotspot(t *testing.T) {
	for kind, sh := range cursorShapes {
		if len(sh.path) < 3 {
			t.Errorf("kind %d has %d points", kind, len(sh.path))
		}
		if sh.w <= 0 || sh.h <= 0 {
			t.Errorf("kind %d has no extent: %vx%v", kind, sh.w, sh.h)
		}
		if sh.hotX < 0 || sh.hotX > sh.w || sh.hotY < 0 || sh.hotY > sh.h {
			t.Errorf("kind %d hotspot (%v,%v) is outside its own %vx%v box",
				kind, sh.hotX, sh.hotY, sh.w, sh.h)
		}
		for _, p := range sh.path {
			if p[0] < -0.01 || p[0] > sh.w+0.01 || p[1] < -0.01 || p[1] > sh.h+0.01 {
				t.Errorf("kind %d has a point %v outside its declared %vx%v box", kind, p, sh.w, sh.h)
			}
		}
	}
}

// TestCursorShapesGolden pins the geometry. cursor-draw.ts holds the same
// numbers and asserts the same checksum; without that pair the preview and the
// export draw different cursors, which is the one thing a preview may not do.
func TestCursorShapesGolden(t *testing.T) {
	want := map[uint8]struct {
		points   int
		checksum float64
	}{
		kindArrow:   {7, 7.6900},
		kindText:    {12, 9.0000},
		kindHand:    {16, 13.9800},
		kindCross:   {12, 12.0000},
		kindResizeH: {10, 8.0000},
		kindResizeV: {10, 8.0000},
	}
	for kind, w := range want {
		sh := cursorShapes[kind]
		if len(sh.path) != w.points {
			t.Errorf("kind %d has %d points, want %d", kind, len(sh.path), w.points)
			continue
		}
		var sum float64
		for _, p := range sh.path {
			sum += p[0] + p[1]
		}
		if math.Abs(sum-w.checksum) > 0.0001 {
			t.Errorf("kind %d checksum %.4f, want %.4f", kind, sum, w.checksum)
		}
	}
}

// Each shape is sized by its HEIGHT, so a crosshair (square) and an I-beam
// (half as wide as tall) read as the same weight at the same setting.
func TestShapesAreSizedByHeight(t *testing.T) {
	dir := t.TempDir()
	for _, kind := range []uint8{kindArrow, kindText, kindHand, kindCross, kindResizeH, kindResizeV} {
		p := filepath.Join(dir, "s.png")
		_, h, _, _, err := writePointerPNG(p, "arrow", kind, 40, 0, hexColor("#ffffff", "#ffffff"), 1)
		if err != nil {
			t.Fatal(err)
		}
		// 40 plus the stroke's inset on both sides and a pixel of slack.
		if h < 40 || h > 56 {
			t.Errorf("kind %d drew %d tall for a size of 40", kind, h)
		}
	}
}

// An explicitly stylised pointer opts out: asking for a dot and getting an
// I-beam over every text field would be ignoring what was asked for.
func TestStylisedPointersIgnoreTheShape(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	writeTrackHidden(t, src, 640, 360, kindWalk(map[int64]uint8{0: kindArrow, 1000: kindText}, 3000), true)

	for _, style := range []string{"dot", "ring"} {
		doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{Size: 40, Style: style}})
		args := compileFor(t, doc, src, dir)
		if strings.Count(args, "-ptr") > 2 {
			t.Errorf("style %q built more than one pointer overlay:\n%s", style, args)
		}
	}
}

// The end-to-end check: a take that starts on an arrow and moves to a text
// cursor has to actually render two different shapes.
func TestShapeChangesRender(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "black")
	writeTrackHidden(t, src, 640, 360, kindWalk(map[int64]uint8{0: kindArrow, 1500: kindText}, 3000), true)

	out := filepath.Join(dir, "o.mp4")
	doc := cursorDoc(&schema.CursorFX{Pointer: &schema.CursorPointer{
		Size: 80, Color: "#ff0000", Opacity: 1,
	}})
	plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v\n%s", err, lastLines(string(b), 10))
	}

	shape := func(at string) int {
		t.Helper()
		png := filepath.Join(dir, "k"+at+".png")
		if b, err := exec.Command("ffmpeg", "-y", "-loglevel", "error", "-ss", at, "-i", out,
			"-frames:v", "1", "-update", "1", png).CombinedOutput(); err != nil {
			t.Fatalf("extract %s: %v\n%s", at, err, b)
		}
		_, _, n := redCentroid(t, png)
		return n
	}
	// An arrow and an I-beam of the same height cover visibly different areas —
	// the arrow is a solid wedge, the I-beam two serifs and a stem.
	arrow, text := shape("0.5"), shape("2.5")
	if arrow == 0 || text == 0 {
		t.Fatalf("a shape failed to draw: arrow %d px, text %d px", arrow, text)
	}
	if arrow == text {
		t.Errorf("both moments drew the same %d px shape — the cursor never changed", arrow)
	}
	if text > arrow {
		t.Errorf("the I-beam (%d px) covers more than the arrow (%d px); the shapes are swapped", text, arrow)
	}
}
