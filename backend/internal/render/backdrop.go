package render

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"strings"

	"studio/internal/schema"
)

/*
Backdrop scenes — a gradient wallpaper behind the recording, the picture pulled
in from the edges with rounded corners and a soft shadow. It is the single
biggest "produced vs raw" signal a screen recording can carry, and every tool
in this product's territory (Screen Studio most famously) leads with it.

Like device frames, the composite happens at CANVAS resolution before the
clip's own transform, so a zoom pushes into the scene rather than sliding the
wallpaper out from behind its own picture. And like device frames, everything
is drawn with the SDF machinery rather than shipped as art, for the same three
reasons (resolution independence, geometry the code knows, recolour by field).

The geometry lives in backdropLayout and is golden-tested in BOTH languages
(frontend/src/backdrop.ts) — the exporter composites into this rectangle and
the preview positions a DOM node onto it, so they may never disagree.
*/

// Defaults, shared by name with the frontend's BACKDROP_DEFAULTS.
const (
	backdropDefInset  = 0.06
	backdropDefRadius = 14.0 // px at 1080-high reference
	backdropDefShadow = 0.55
	backdropMaxInset  = 0.35
)

func backdropInset(b *schema.Backdrop) float64 {
	f := b.Inset
	if f == 0 {
		f = backdropDefInset
	}
	return clampF(f, 0, backdropMaxInset)
}

// backdropGeom is where the picture goes, in canvas pixels.
type backdropGeom struct {
	x, y, w, h int
	radius     float64 // corner radius in canvas px
}

/*
backdropLayout fits the picture into the inset canvas, centred, aspect kept.

`vw, vh` are the source's own pixels; unknown (0) is treated as canvas-shaped,
which keeps a dimensionless doc rendering instead of erroring. Dimensions are
forced even for the same 4:2:0 reason every other layout here does it.
*/
func backdropLayout(b *schema.Backdrop, vw, vh, w, h int) backdropGeom {
	if vw <= 0 || vh <= 0 {
		vw, vh = w, h
	}
	inset := backdropInset(b)
	availW := float64(w) * (1 - 2*inset)
	availH := float64(h) * (1 - 2*inset)
	k := math.Min(availW/float64(vw), availH/float64(vh))
	cw := even(float64(vw) * k)
	ch := even(float64(vh) * k)
	radius := b.Radius
	if radius == 0 {
		radius = backdropDefRadius
	}
	// Radius is quoted at a 1080-high reference like the schema's other px
	// sizes, then capped so it cannot swallow the card.
	radius = clampF(radius*float64(h)/1080, 0, math.Min(float64(cw), float64(ch))/2)
	return backdropGeom{
		x:      even((float64(w) - float64(cw)) / 2),
		y:      even((float64(h) - float64(ch)) / 2),
		w:      cw,
		h:      ch,
		radius: radius,
	}
}

// backdropColors resolves the wallpaper pair (flat when Color2 is empty).
func backdropColors(b *schema.Backdrop) (color.NRGBA, color.NRGBA) {
	c1 := hexColor(b.Color1, "#23262f")
	c2 := c1
	if b.Color2 != "" {
		c2 = hexColor(b.Color2, "#23262f")
	}
	return c1, c2
}

/*
renderBackdropPNG draws the wallpaper, with the card's shadow already in it.

The shadow is painted into the wallpaper rather than composited live because it
never moves relative to either: card and wallpaper are one object by design.
Its falloff is the rounded-rect SDF pushed through an exponential — cheap, and
soft in exactly the shape of the card, corners included.

withShadow is false under a device frame, whose silhouette is not the card
rectangle — a rectangular glow behind a phone reads as a rendering bug.
*/
func renderBackdropPNG(b *schema.Backdrop, g backdropGeom, w, h int, withShadow bool, outPath string) error {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	c1, c2 := backdropColors(b)

	// Vertical gradient, top to bottom.
	for y := 0; y < h; y++ {
		f := float64(y) / math.Max(1, float64(h-1))
		lerp := func(a, b uint8) uint8 { return uint8(float64(a) + (float64(b)-float64(a))*f) }
		row := color.NRGBA{R: lerp(c1.R, c2.R), G: lerp(c1.G, c2.G), B: lerp(c1.B, c2.B), A: 255}
		for x := 0; x < w; x++ {
			over(img, x, y, row, 1)
		}
	}

	shadow := b.Shadow
	if shadow == 0 {
		shadow = backdropDefShadow
	}
	if withShadow && shadow > 0 {
		s := clampF(shadow, 0, 1)
		// Offset down a touch, blurred at ~3% of canvas height. Painted with
		// over(), which composes premultiplied — see the annotation.go lesson.
		cx := float64(g.x) + float64(g.w)/2
		cy := float64(g.y) + float64(g.h)/2 + float64(h)*0.012
		blur := float64(h) * 0.03
		dark := color.NRGBA{R: 0, G: 0, B: 0, A: 255}
		pad := blur * 5
		bounds := boxAround(float64(g.x)-pad, float64(g.y)-pad, float64(g.x+g.w)+pad, float64(g.y+g.h)+pad, 2)
		r := bounds.Intersect(img.Bounds())
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				d := sdRoundRect(float64(x)+0.5, float64(y)+0.5, cx, cy, float64(g.w)/2, float64(g.h)/2, g.radius)
				if d <= 0 {
					over(img, x, y, dark, 0.42*s)
					continue
				}
				a := 0.42 * s * math.Exp(-d/blur)
				if a > 1.0/255 {
					over(img, x, y, dark, a)
				}
			}
		}
	}
	return encodePNG(outPath, img)
}

// renderBackdropMaskPNG is the card's alpha: a white rounded rectangle,
// antialiased by the same coverage() every other shape here uses. alphamerge
// reads it as grayscale, so white = opaque, the corners fade out.
func renderBackdropMaskPNG(g backdropGeom, outPath string) error {
	img := image.NewRGBA(image.Rect(0, 0, g.w, g.h))
	cx, cy := float64(g.w)/2, float64(g.h)/2
	white := color.NRGBA{R: 255, G: 255, B: 255, A: 255}
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			cov := coverage(sdRoundRect(float64(x)+0.5, float64(y)+0.5, cx, cy, cx, cy, g.radius))
			if cov > 0 {
				over(img, x, y, white, cov)
			}
		}
	}
	return encodePNG(outPath, img)
}

/*
writeBackdrop fits the picture into the card, rounds its corners, and lays it
on the wallpaper, returning the label the chain continues from.

The picture is fitted (never stretched) into the card rectangle the layout
promised; a source that isn't the card's shape pads with black inside the card,
the same honest answer a device screen gives. The mask REPLACES the alpha
(alphamerge, not a multiply) — correct precisely because the fit has just
padded the card opaque edge-to-edge, so the only alpha that matters is the
card's own outline.
*/
func writeBackdrop(fc *strings.Builder, in string, i, bgIdx, maskIdx int, g backdropGeom) string {
	pic := fmt.Sprintf("[bdp%d]", i)
	msk := fmt.Sprintf("[bdm%d]", i)
	wall := fmt.Sprintf("[bdw%d]", i)
	out := fmt.Sprintf("[bd%d]", i)

	fmt.Fprintf(fc,
		"%sscale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba%s;",
		in, g.w, g.h, g.w, g.h, pic)
	fmt.Fprintf(fc, "[%d:v]format=gray%s;", maskIdx, msk)
	fmt.Fprintf(fc, "%s%salphamerge%s;", pic, msk, fmt.Sprintf("[bdc%d]", i))
	fmt.Fprintf(fc, "[%d:v]format=rgba%s;", bgIdx, wall)
	fmt.Fprintf(fc, "%s[bdc%d]overlay=%d:%d:format=auto%s;", wall, i, g.x, g.y, out)
	return out
}

// writeBackdropUnder lays an already canvas-shaped stream (a device composite)
// over the wallpaper alone — the device supplies its own body and shadow.
func writeBackdropUnder(fc *strings.Builder, in string, i, bgIdx int) string {
	wall := fmt.Sprintf("[bdw%d]", i)
	out := fmt.Sprintf("[bd%d]", i)
	fmt.Fprintf(fc, "[%d:v]format=rgba%s;", bgIdx, wall)
	fmt.Fprintf(fc, "%s%soverlay=0:0:format=auto%s;", wall, in, out)
	return out
}
