package render

import (
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

// The annotation renderer is pure pixels, so the tests read pixels. Each one
// pins a property a broken shape would visibly violate, rather than a hash —
// a golden image would fail on every antialiasing tweak and tell you nothing.

// A realistic canvas. Thicknesses are in 1080-reference units, so on a tiny
// test canvas every stroke collapses to about a pixel and the properties below
// stop being measurable — a partial-coverage edge is not a drawing bug.
const tw, th = 960, 540

func draw(t *testing.T, a schema.Annotation) *image.RGBA {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, tw, th))
	if err := drawAnnotation(img, a, tw, th); err != nil {
		t.Fatalf("drawAnnotation(%s): %v", a.Kind, err)
	}
	return img
}

func alphaAt(img *image.RGBA, xf, yf float64) uint8 {
	x, y := int(xf*float64(tw)), int(yf*float64(th))
	if x < 0 || y < 0 || x >= tw || y >= th {
		return 0
	}
	return img.Pix[img.PixOffset(x, y)+3]
}

func opaquePixels(img *image.RGBA) int {
	n := 0
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] > 8 {
			n++
		}
	}
	return n
}

// A box is an outline: its edges are drawn and its middle is left alone, or it
// would hide the very thing it is drawn to point at.
func TestBoxIsHollow(t *testing.T) {
	img := draw(t, schema.Annotation{Kind: schema.AnnoBox, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Thickness: 16})

	if a := alphaAt(img, 0.5, 0.25); a < 200 {
		t.Errorf("top edge alpha = %d, want the stroke to be drawn", a)
	}
	if a := alphaAt(img, 0.25, 0.5); a < 200 {
		t.Errorf("left edge alpha = %d, want the stroke to be drawn", a)
	}
	if a := alphaAt(img, 0.5, 0.5); a != 0 {
		t.Errorf("centre alpha = %d, want a hollow box", a)
	}
	if a := alphaAt(img, 0.05, 0.05); a != 0 {
		t.Errorf("outside alpha = %d, want nothing beyond the box", a)
	}
}

func TestBoxFillsWhenAsked(t *testing.T) {
	img := draw(t, schema.Annotation{
		Kind: schema.AnnoBox, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Thickness: 16, Fill: "#ff0000",
	})
	if a := alphaAt(img, 0.5, 0.5); a < 200 {
		t.Errorf("centre alpha = %d, want the fill", a)
	}
}

// The whole point of a highlight is that you can still read what is under it.
func TestHighlightIsTranslucent(t *testing.T) {
	img := draw(t, schema.Annotation{Kind: schema.AnnoHighlight, X: 0.2, Y: 0.4, W: 0.6, H: 0.2})
	a := alphaAt(img, 0.5, 0.5)
	if a == 0 {
		t.Fatal("highlight drew nothing")
	}
	if a > 200 {
		t.Errorf("highlight alpha = %d, want it to show the frame through", a)
	}
}

// An ellipse must not paint its bounding box's corners — that is the one thing
// distinguishing it from a box, and an sdf sign error would silently fill them.
func TestEllipseSparesTheCorners(t *testing.T) {
	img := draw(t, schema.Annotation{Kind: schema.AnnoEllipse, X: 0.2, Y: 0.2, W: 0.6, H: 0.6, Thickness: 12})
	for _, c := range [][2]float64{{0.21, 0.21}, {0.79, 0.21}, {0.21, 0.79}, {0.79, 0.79}} {
		if a := alphaAt(img, c[0], c[1]); a != 0 {
			t.Errorf("corner (%.2f,%.2f) alpha = %d, want it empty", c[0], c[1], a)
		}
	}
	if a := alphaAt(img, 0.5, 0.2); a < 150 {
		t.Errorf("top of the ellipse alpha = %d, want the stroke", a)
	}
}

// An arrow has to reach its target; pointing near the thing is not pointing at it.
func TestArrowReachesItsPoint(t *testing.T) {
	a := schema.Annotation{Kind: schema.AnnoArrow, X: 0.1, Y: 0.5, X2: 0.9, Y2: 0.5, Thickness: 14}
	img := draw(t, a)

	if got := alphaAt(img, 0.89, 0.5); got < 200 {
		t.Errorf("alpha at the tip = %d, want the arrow to arrive", got)
	}
	if got := alphaAt(img, 0.5, 0.5); got < 200 {
		t.Errorf("alpha along the shaft = %d, want a connected arrow", got)
	}
	// Somewhere there is a head, and it is decidedly wider than the shaft.
	// Measured as the widest column rather than at a guessed x: the head only
	// occupies the last few percent of the arrow, so sampling "near the tip"
	// lands on the shaft and proves nothing.
	colHeight := func(xf float64) int {
		n := 0
		for y := 0; y < th; y++ {
			if alphaAt(img, xf, float64(y)/float64(th)) > 128 {
				n++
			}
		}
		return n
	}
	shaftW := colHeight(0.4)
	widest := 0
	for x := 0.1; x <= 0.9; x += 0.005 {
		if n := colHeight(x); n > widest {
			widest = n
		}
	}
	if shaftW == 0 {
		t.Fatal("no shaft drawn")
	}
	if float64(widest) < float64(shaftW)*1.5 {
		t.Errorf("widest point %d vs shaft %d, want a distinctly wider arrowhead", widest, shaftW)
	}
}

func TestZeroLengthArrowDrawsNothing(t *testing.T) {
	img := draw(t, schema.Annotation{Kind: schema.AnnoArrow, X: 0.5, Y: 0.5, X2: 0.5, Y2: 0.5, Thickness: 14})
	if n := opaquePixels(img); n != 0 {
		t.Errorf("%d pixels drawn, want nothing for a zero-length arrow", n)
	}
}

// An arrow pointing anywhere must stay attached to its tail — the shaft is
// shortened to meet the head, and getting that backwards detaches them.
func TestArrowStaysConnectedInEveryDirection(t *testing.T) {
	for _, d := range []struct {
		name           string
		x1, y1, x2, y2 float64
	}{
		{"right", 0.1, 0.5, 0.9, 0.5},
		{"left", 0.9, 0.5, 0.1, 0.5},
		{"down", 0.5, 0.1, 0.5, 0.9},
		{"up", 0.5, 0.9, 0.5, 0.1},
		{"diagonal", 0.15, 0.15, 0.85, 0.85},
	} {
		t.Run(d.name, func(t *testing.T) {
			img := draw(t, schema.Annotation{
				Kind: schema.AnnoArrow, X: d.x1, Y: d.y1, X2: d.x2, Y2: d.y2, Thickness: 14,
			})
			// Walk the line; every step of the way something must be painted.
			for i := 1; i < 20; i++ {
				p := float64(i) / 20
				x := d.x1 + (d.x2-d.x1)*p
				y := d.y1 + (d.y2-d.y1)*p
				if alphaAt(img, x, y) < 100 {
					t.Fatalf("gap at %.0f%% along the arrow", p*100)
				}
			}
		})
	}
}

// Geometry is in canvas fractions so a callout survives an export at another
// size. Same annotation, twice the canvas, same relative placement.
func TestGeometryIsResolutionIndependent(t *testing.T) {
	a := schema.Annotation{Kind: schema.AnnoBox, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Thickness: 8}

	small := image.NewRGBA(image.Rect(0, 0, 320, 180))
	if err := drawAnnotation(small, a, 320, 180); err != nil {
		t.Fatal(err)
	}
	big := image.NewRGBA(image.Rect(0, 0, 640, 360))
	if err := drawAnnotation(big, a, 640, 360); err != nil {
		t.Fatal(err)
	}

	// Four times the pixels, and a stroke that also doubled, so the painted area
	// should be about four times as large too.
	sn, bn := opaquePixels(small), opaquePixels(big)
	ratio := float64(bn) / float64(sn)
	if math.Abs(ratio-4) > 0.6 {
		t.Errorf("painted-area ratio %.2f (%d → %d), want ~4", ratio, sn, bn)
	}
}

func TestOpacityScalesTheWholeShape(t *testing.T) {
	full := draw(t, schema.Annotation{Kind: schema.AnnoBox, X: 0.2, Y: 0.2, W: 0.6, H: 0.6, Thickness: 10})
	half := draw(t, schema.Annotation{Kind: schema.AnnoBox, X: 0.2, Y: 0.2, W: 0.6, H: 0.6, Thickness: 10, Opacity: 0.5})

	f := alphaAt(full, 0.5, 0.2)
	h := alphaAt(half, 0.5, 0.2)
	if f == 0 || h == 0 {
		t.Fatal("expected the stroke to be drawn in both")
	}
	if got := float64(h) / float64(f); math.Abs(got-0.5) > 0.1 {
		t.Errorf("alpha ratio %.2f, want ~0.5", got)
	}
}

// An unknown kind must not draw a guess — the caller drops the clip instead.
func TestUnknownKindIsAnError(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, tw, th))
	if err := drawAnnotation(img, schema.Annotation{Kind: "speech-bubble"}, tw, th); err == nil {
		t.Fatal("want an error for an unknown kind")
	}
	if n := opaquePixels(img); n != 0 {
		t.Errorf("%d pixels drawn for an unknown kind, want none", n)
	}
}

// A number badge is the disc plus its digits; both have to be there.
func TestNumberBadgeDrawsDiscAndDigits(t *testing.T) {
	bare := draw(t, schema.Annotation{Kind: schema.AnnoNumber, X: 0.35, Y: 0.3, W: 0.3, H: 0.4})
	withText := draw(t, schema.Annotation{
		Kind: schema.AnnoNumber, X: 0.35, Y: 0.3, W: 0.3, H: 0.4, Text: "3", TextColor: "#000000",
	})
	if alphaAt(bare, 0.5, 0.5) < 200 {
		t.Error("badge disc not drawn")
	}
	// The digit is painted in black over the disc, so the colour must change
	// somewhere near the centre even though alpha stays opaque.
	differs := false
	for y := 0.42; y < 0.58 && !differs; y += 0.01 {
		for x := 0.44; x < 0.56; x += 0.01 {
			bx, by := int(x*tw), int(y*th)
			i := bare.PixOffset(bx, by)
			if bare.Pix[i] != withText.Pix[i] {
				differs = true
				break
			}
		}
	}
	if !differs {
		t.Error("the digits were not drawn onto the badge")
	}
}

func TestSDFPrimitives(t *testing.T) {
	// Inside is negative, on the boundary is zero, outside is positive — every
	// shape's antialiasing depends on that sign convention holding.
	if d := sdRoundRect(50, 50, 50, 50, 20, 20, 0); d >= 0 {
		t.Errorf("centre of a rect = %.2f, want negative", d)
	}
	if d := sdRoundRect(70, 50, 50, 50, 20, 20, 0); math.Abs(d) > 0.001 {
		t.Errorf("edge of a rect = %.2f, want ~0", d)
	}
	if d := sdEllipse(50, 50, 50, 50, 20, 10); d >= 0 {
		t.Errorf("centre of an ellipse = %.2f, want negative", d)
	}
	if d := sdEllipse(70, 50, 50, 50, 20, 10); math.Abs(d) > 0.001 {
		t.Errorf("edge of an ellipse = %.2f, want ~0", d)
	}
	if d := sdSegment(50, 60, 0, 50, 100, 50); math.Abs(d-10) > 0.001 {
		t.Errorf("10px off a segment = %.2f, want 10", d)
	}
}

// Golden arrow geometry, asserted with the SAME numbers in the frontend's
// annotation.test.ts ("agrees with the Go renderer, to the number"). The
// preview and the export build the arrow independently; these values are the
// only thing keeping them pointing at the same place.
func TestArrowGeometryGolden(t *testing.T) {
	pts, stopX, stopY := arrowHead(0, 0, 100, 0, 10)
	if pts == nil {
		t.Fatal("no head")
	}
	want := [][2]float64{{100, 0}, {66, 15.5}, {66, -15.5}}
	for i, p := range want {
		if math.Abs(pts[i][0]-p[0]) > 1e-9 || math.Abs(pts[i][1]-p[1]) > 1e-9 {
			t.Errorf("point %d = (%.4f,%.4f), want (%.4f,%.4f)", i, pts[i][0], pts[i][1], p[0], p[1])
		}
	}
	if math.Abs(stopX-71.1) > 1e-9 || math.Abs(stopY) > 1e-9 {
		t.Errorf("shaft stop = (%.4f,%.4f), want (71.1,0)", stopX, stopY)
	}
}

/*
Colour must survive being written to a PNG.

image.RGBA is alpha-premultiplied, so composing straight-alpha values into one
looks correct in memory and is then wrecked by png.Encode un-premultiplying it.
This shipped once: a 45%-alpha yellow highlight (253,224,71) came out of the
encoder as green (56,247,159), and every test that only read the alpha channel
passed. Reading back through the encoder is the only thing that catches it.
*/
func TestTranslucentColourSurvivesEncoding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.png")
	if err := renderAnnotationPNG(schema.Annotation{
		Kind: schema.AnnoHighlight, X: 0.2, Y: 0.2, W: 0.5, H: 0.5, Color: "#fde047",
	}, 200, 200, path); err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	nr, ok := img.(*image.NRGBA)
	if !ok {
		t.Fatalf("png decoded as %T, want *image.NRGBA", img)
	}

	i := nr.PixOffset(100, 100)
	got := [4]uint8{nr.Pix[i], nr.Pix[i+1], nr.Pix[i+2], nr.Pix[i+3]}
	want := [4]uint8{253, 224, 71, 114}
	for k, name := range []string{"R", "G", "B", "A"} {
		if d := int(got[k]) - int(want[k]); d > 2 || d < -2 {
			t.Errorf("%s = %d, want %d (whole pixel %v, want %v)", name, got[k], want[k], got, want)
		}
	}
}

/*
Keycap layout must match keysLayout() in annotation.ts exactly.

Cap widths come from rune count rather than measured glyphs for precisely this
reason: Go and the browser measure text differently, and a few percent per label
compounds across a row until the last cap is visibly out of place. These numbers
are asserted identically on the TypeScript side; either half changing alone
fails on one side or the other rather than quietly making the editor lie about
the render.
*/
func TestKeysLayoutGolden(t *testing.T) {
	caps, w, h := keysLayout("Cmd+C", 40)
	if len(caps) != 2 {
		t.Fatalf("caps = %d, want 2", len(caps))
	}
	if math.Abs(h-64) > 1e-9 {
		t.Errorf("height = %.4f, want 64", h)
	}
	if math.Abs(caps[0].w-110.4) > 1e-9 || math.Abs(caps[0].x) > 1e-9 { // 3 runes
		t.Errorf("cap 0 = x%.4f w%.4f, want x0 w110.4", caps[0].x, caps[0].w)
	}
	if math.Abs(caps[1].w-64) > 1e-9 { // 1 rune → square minimum
		t.Errorf("cap 1 w = %.4f, want 64", caps[1].w)
	}
	if math.Abs(caps[1].x-127.2) > 1e-9 { // 110.4 + a 16.8 gap
		t.Errorf("cap 1 x = %.4f, want 127.2", caps[1].x)
	}
	if math.Abs(w-191.2) > 1e-9 {
		t.Errorf("width = %.4f, want 191.2", w)
	}

	caps, w, _ = keysLayout("Ctrl+Shift+P", 40)
	for i, want := range []float64{135.2, 160, 64} {
		if math.Abs(caps[i].w-want) > 1e-9 {
			t.Errorf("cap %d w = %.4f, want %.4f", i, caps[i].w, want)
		}
	}
	if math.Abs(w-392.8) > 1e-9 {
		t.Errorf("width = %.4f, want 392.8", w)
	}
}

// Measuring bytes rather than runes would make any non-ASCII label too wide.
// "é" is two bytes and one key.
func TestKeycapMeasuresRunesNotBytes(t *testing.T) {
	e, _, _ := keysLayout("é", 40)
	c, _, _ := keysLayout("C", 40)
	if e[0].w != c[0].w {
		t.Errorf("é cap = %.4f, C cap = %.4f, want equal", e[0].w, c[0].w)
	}
}

/*
The Mac modifier symbols must be spelled out, here and in annotation.ts.

Arial — the face fontPath() picks on a Mac — has no ⌘ (U+2318) or ⇧ (U+21E7),
so a badge reading "⌘+C" exported as a tofu box beside a C while the browser
preview drew it perfectly. Worse, a Linux render host with DejaVu DOES have
those glyphs, so the same project would have exported differently per machine.
Canonicalising in both halves is what makes the output host-independent.
*/
func TestMacSymbolsAreSpelledOut(t *testing.T) {
	got := splitKeys("⌘+⇧+4")
	want := []string{"Cmd", "Shift", "4"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("splitKeys(⌘+⇧+4) = %v, want %v", got, want)
		}
	}
	// And the width follows the word actually drawn, not the symbol typed.
	sym, _, _ := keysLayout("⌘", 40)
	word, _, _ := keysLayout("Cmd", 40)
	if sym[0].w != word[0].w {
		t.Errorf("⌘ cap = %.4f, Cmd cap = %.4f, want equal", sym[0].w, word[0].w)
	}
}

func TestSplitKeys(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want []string
	}{
		{"ctrl+shift+p", []string{"ctrl", "shift", "p"}},
		{"ctrl+", []string{"ctrl"}}, // mid-typing, not an empty cap
		{"  cmd  +  c  ", []string{"cmd", "c"}},
		{"+", []string{"+"}}, // splitting yields nothing; keep the key
		{"   ", nil},
	} {
		got := splitKeys(tc.in)
		if len(got) != len(tc.want) {
			t.Errorf("splitKeys(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitKeys(%q) = %v, want %v", tc.in, got, tc.want)
				break
			}
		}
	}
}

/*
A keystroke badge must actually put ink where the layout says it does.

The badge is drawn from the annotation's own origin, so this checks the caps
land inside their computed boxes and that the gap between them stays clear —
the failure this catches is a row that renders as one merged slab.
*/
func TestKeycapsLandWhereTheLayoutSaysAndAreSeparate(t *testing.T) {
	const w, h = 400, 200
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	a := schema.Annotation{
		Kind: schema.AnnoKeys, X: 0.1, Y: 0.4, Text: "Cmd+C", TextSize: 40, Fill: "#1e293b",
	}
	if err := drawAnnotation(img, a, w, h); err != nil {
		t.Fatal(err)
	}
	ref := float64(h) / 1080
	caps, _, _ := keysLayout(a.Text, 40*ref)
	x0, y0 := a.X*float64(w), a.Y*float64(h)

	alphaAt := func(x, y float64) uint8 { return img.RGBAAt(int(x), int(y)).A }
	for i, k := range caps {
		cx, cy := x0+k.x+k.w/2, y0+k.y+k.h/2
		if alphaAt(cx, cy) == 0 {
			t.Errorf("cap %d is blank at its centre (%.1f,%.1f)", i, cx, cy)
		}
	}
	// The gap between the two caps must stay transparent, or they have merged.
	gapX := x0 + caps[0].w + (caps[1].x-caps[0].w)/2
	gapY := y0 + caps[0].h/2
	if got := alphaAt(gapX, gapY); got != 0 {
		t.Errorf("gap between caps has alpha %d at (%.1f,%.1f), want 0", got, gapX, gapY)
	}
}

// Nothing typed yet must draw nothing, not an empty cap floating on the frame.
func TestEmptyKeysDrawNothing(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	if err := drawAnnotation(img, schema.Annotation{Kind: schema.AnnoKeys, X: 0.1, Y: 0.1}, 100, 100); err != nil {
		t.Fatal(err)
	}
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 0 {
			t.Fatal("empty keys annotation painted something")
		}
	}
}
