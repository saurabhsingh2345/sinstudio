package render

import (
	"errors"
	"image"
	"image/color"
	"math"
	"strings"

	"studio/internal/schema"
)

// errUnknownAnnotation drops the clip rather than drawing a guess.
var errUnknownAnnotation = errors.New("render: unknown annotation kind")

// Annotation callouts — the arrows, boxes and step numbers a tutorial points
// with. They render to a full-canvas transparent PNG exactly like titles do, so
// the whole transform/keyframe/transition pipeline applies to them for free and
// the filtergraph needs no new cases.
//
// Every shape is drawn from a signed distance function rather than by plotting
// pixels per shape. One `sdf` per kind buys antialiasing, a fill and a stroke of
// any width from the same three lines of compositing, and the shapes agree with
// each other at their edges — which hand-rolled rasterisers usually don't.

// sdf is the signed distance from a point to a shape's boundary, in pixels:
// negative inside, positive outside.
type sdf func(x, y float64) float64

/*
Rounded rectangle. Folding the corner radius in by shrinking the box and adding
it back to the distance is what makes a single expression cover square corners
(r = 0) and fully round ones without branching.
*/
func sdRoundRect(x, y, cx, cy, hw, hh, r float64) float64 {
	r = math.Min(r, math.Min(hw, hh))
	qx := math.Abs(x-cx) - (hw - r)
	qy := math.Abs(y-cy) - (hh - r)
	return math.Hypot(math.Max(qx, 0), math.Max(qy, 0)) + math.Min(math.Max(qx, qy), 0) - r
}

/*
Ellipse. The exact distance to an ellipse needs a quartic root; this scales
space so the ellipse becomes a unit circle and rescales the result by the
smaller radius. It is exact for a circle and close enough elsewhere that a 1px
antialiased edge is indistinguishable — which is all the distance is used for.
*/
func sdEllipse(x, y, cx, cy, rx, ry float64) float64 {
	if rx <= 0 || ry <= 0 {
		return math.MaxFloat64
	}
	nx, ny := (x-cx)/rx, (y-cy)/ry
	k := math.Hypot(nx, ny)
	if k == 0 {
		return -math.Min(rx, ry)
	}
	return (k - 1) * math.Min(rx, ry)
}

// Distance to a line segment — the arrow's shaft before it is given a width.
func sdSegment(x, y, ax, ay, bx, by float64) float64 {
	px, py := x-ax, y-ay
	dx, dy := bx-ax, by-ay
	dd := dx*dx + dy*dy
	h := 0.0
	if dd > 0 {
		h = clampF((px*dx+py*dy)/dd, 0, 1)
	}
	return math.Hypot(px-dx*h, py-dy*h)
}

/*
Convex polygon, as the largest of the signed distances to its edge lines. Inside
the shape that is exact; outside it underestimates near a corner, which at a
one-pixel antialiased edge is invisible. Points must wind consistently.
*/
func sdConvex(x, y float64, pts [][2]float64) float64 {
	if len(pts) < 3 {
		return math.MaxFloat64
	}
	d := -math.MaxFloat64
	for i := range pts {
		a := pts[i]
		b := pts[(i+1)%len(pts)]
		ex, ey := b[0]-a[0], b[1]-a[1]
		l := math.Hypot(ex, ey)
		if l == 0 {
			continue
		}
		// Outward normal for clockwise winding in screen space (y down).
		d = math.Max(d, ((x-a[0])*ey-(y-a[1])*ex)/l)
	}
	return d
}

// union is the shape covering either input — a nearer boundary wins.
func union(a, b sdf) sdf {
	return func(x, y float64) float64 { return math.Min(a(x, y), b(x, y)) }
}

// coverage turns a signed distance into a one-pixel-wide antialiased edge.
func coverage(d float64) float64 { return clampF(0.5-d, 0, 1) }

/*
over composites a source colour onto a pixel, with `a` as extra coverage.

image.RGBA is **alpha-premultiplied**, so this composites in premultiplied space
— out = src*srcAlpha + dst*(1-srcAlpha), for the colour channels as well as
alpha. Writing straight-alpha values into an image.RGBA instead looks right in
memory and is then mangled by png.Encode, which un-premultiplies on the way out:
a 45%-alpha yellow highlight came back as opaque green. Any shape with alpha
below 255 is affected, so a translucent callout is the case to check if this is
ever touched again.
*/
func over(dst *image.RGBA, x, y int, c color.NRGBA, a float64) {
	if a <= 0 {
		return
	}
	sa := a * float64(c.A) / 255
	if sa <= 0 {
		return
	}
	i := dst.PixOffset(x, y)
	inv := 1 - sa
	blend := func(s, d uint8) uint8 {
		return uint8(clampF(float64(s)*sa+float64(d)*inv+0.5, 0, 255))
	}
	dst.Pix[i] = blend(c.R, dst.Pix[i])
	dst.Pix[i+1] = blend(c.G, dst.Pix[i+1])
	dst.Pix[i+2] = blend(c.B, dst.Pix[i+2])
	dst.Pix[i+3] = uint8(clampF(sa*255+float64(dst.Pix[i+3])*inv+0.5, 0, 255))
}

/*
paintSDF fills and strokes a shape.

`bounds` keeps the per-pixel loop off the rest of a 2-megapixel canvas; it is a
speed measure only, so it is generous rather than tight, and a shape clipped by
too small a box would be a silent visual bug.
*/
func paintSDF(img *image.RGBA, d sdf, bounds image.Rectangle, fill *color.NRGBA, stroke *color.NRGBA, thickness float64) {
	r := bounds.Intersect(img.Bounds())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			// Sample at the pixel centre, matching the half-pixel offset that
			// coverage() assumes.
			dist := d(float64(x)+0.5, float64(y)+0.5)
			if fill != nil {
				over(img, x, y, *fill, coverage(dist))
			}
			if stroke != nil && thickness > 0 {
				over(img, x, y, *stroke, coverage(math.Abs(dist)-thickness/2))
			}
		}
	}
}

// boxAround is the paint bounds for a shape occupying (x0,y0)-(x1,y1) with a
// stroke of `pad` px, rounded outward.
func boxAround(x0, y0, x1, y1, pad float64) image.Rectangle {
	if x1 < x0 {
		x0, x1 = x1, x0
	}
	if y1 < y0 {
		y0, y1 = y1, y0
	}
	p := pad + 2
	return image.Rect(int(x0-p)-1, int(y0-p)-1, int(x1+p)+2, int(y1+p)+2)
}

// arrowHead returns the triangle for an arrow pointing at (bx,by) from (ax,ay),
// plus the point the shaft should stop at so it doesn't poke through the tip.
func arrowHead(ax, ay, bx, by, t float64) (pts [][2]float64, stopX, stopY float64) {
	dx, dy := bx-ax, by-ay
	l := math.Hypot(dx, dy)
	if l == 0 {
		return nil, bx, by
	}
	ux, uy := dx/l, dy/l
	head := math.Min(t*3.4, l) // never longer than the arrow itself
	half := t * 1.55           // clearly wider than the shaft, so it reads as a point
	stopX, stopY = bx-ux*head*0.85, by-uy*head*0.85
	baseX, baseY := bx-ux*head, by-uy*head
	// Perpendicular, screen-space.
	px, py := -uy, ux
	return [][2]float64{
		{bx, by},
		{baseX + px*half, baseY + py*half},
		{baseX - px*half, baseY - py*half},
	}, stopX, stopY
}

/*
renderAnnotationPNG draws one callout onto a full-canvas transparent PNG.

Returns an error for a kind it does not know, so an unrecognised annotation
leaves the frame untouched instead of drawing a guess — the caller drops the
clip, exactly as it does for a title it cannot rasterise.
*/
func renderAnnotationPNG(a schema.Annotation, w, h int, outPath string) error {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	if err := drawAnnotation(img, a, w, h); err != nil {
		return err
	}
	return encodePNG(outPath, img)
}

func drawAnnotation(img *image.RGBA, a schema.Annotation, w, h int) error {
	// One reference scale for every length, so a callout authored on a 1080p
	// canvas keeps its proportions when exported at 4K.
	ref := float64(h) / 1080
	fw, fh := float64(w), float64(h)

	x0, y0 := a.X*fw, a.Y*fh
	x1, y1 := (a.X+a.W)*fw, (a.Y+a.H)*fh

	thick := a.Thickness * ref
	if a.Thickness == 0 {
		thick = 6 * ref
	}
	op := a.Opacity
	if op <= 0 {
		op = 1
	}
	stroke := hexColor(a.Color, "#f5a524")
	stroke.A = uint8(clampF(float64(stroke.A)*op, 0, 255))

	var fill *color.NRGBA
	if a.Fill != "" {
		c := hexColor(a.Fill, "#f5a524")
		c.A = uint8(clampF(float64(c.A)*op, 0, 255))
		fill = &c
	}

	switch a.Kind {
	case schema.AnnoArrow:
		ax, ay := a.X*fw, a.Y*fh
		bx, by := a.X2*fw, a.Y2*fh
		head, sx, sy := arrowHead(ax, ay, bx, by, thick)
		if head == nil {
			return nil // zero-length arrow: nothing to point with
		}
		shaft := func(x, y float64) float64 { return sdSegment(x, y, ax, ay, sx, sy) - thick/2 }
		tip := func(x, y float64) float64 { return sdConvex(x, y, head) }
		paintSDF(img, union(shaft, tip), boxAround(ax, ay, bx, by, thick*2), &stroke, nil, 0)

	case schema.AnnoBox:
		cx, cy := (x0+x1)/2, (y0+y1)/2
		hw, hh := math.Abs(x1-x0)/2, math.Abs(y1-y0)/2
		rad := a.Radius * ref
		d := func(x, y float64) float64 { return sdRoundRect(x, y, cx, cy, hw, hh, rad) }
		paintSDF(img, d, boxAround(x0, y0, x1, y1, thick), fill, &stroke, thick)

	case schema.AnnoEllipse:
		cx, cy := (x0+x1)/2, (y0+y1)/2
		d := func(x, y float64) float64 {
			return sdEllipse(x, y, cx, cy, math.Abs(x1-x0)/2, math.Abs(y1-y0)/2)
		}
		paintSDF(img, d, boxAround(x0, y0, x1, y1, thick), fill, &stroke, thick)

	case schema.AnnoHighlight:
		// A marker stripe: filled, translucent, no outline. The fill defaults to
		// the shape colour so a highlight needs only one colour chosen.
		c := stroke
		if fill != nil {
			c = *fill
		}
		c.A = uint8(clampF(float64(c.A)*0.45, 0, 255))
		cx, cy := (x0+x1)/2, (y0+y1)/2
		d := func(x, y float64) float64 {
			return sdRoundRect(x, y, cx, cy, math.Abs(x1-x0)/2, math.Abs(y1-y0)/2, a.Radius*ref)
		}
		paintSDF(img, d, boxAround(x0, y0, x1, y1, 2), &c, nil, 0)

	case schema.AnnoNumber:
		// A step badge: a filled disc sized by the box, with the digits centred.
		r := math.Min(math.Abs(x1-x0), math.Abs(y1-y0)) / 2
		if r <= 0 {
			r = 40 * ref
		}
		cx, cy := (x0+x1)/2, (y0+y1)/2
		c := stroke
		if fill != nil {
			c = *fill
		}
		d := func(x, y float64) float64 { return sdEllipse(x, y, cx, cy, r, r) }
		paintSDF(img, d, boxAround(cx-r, cy-r, cx+r, cy+r, thick), &c, nil, 0)
		size := float64(a.TextSize) * ref
		if a.TextSize == 0 {
			size = r * 1.1 // fills the disc without touching its edge
		}
		drawCentredText(img, a.Text, cx, cy, size, hexColor(a.TextColor, "#ffffff"))

	case schema.AnnoText:
		cx, cy := (x0+x1)/2, (y0+y1)/2
		hw, hh := math.Abs(x1-x0)/2, math.Abs(y1-y0)/2
		rad := a.Radius * ref
		if a.Radius == 0 {
			rad = 14 * ref
		}
		c := stroke
		if fill != nil {
			c = *fill
		}
		d := func(x, y float64) float64 { return sdRoundRect(x, y, cx, cy, hw, hh, rad) }
		paintSDF(img, d, boxAround(x0, y0, x1, y1, thick), &c, nil, 0)
		size := float64(a.TextSize) * ref
		if a.TextSize == 0 {
			size = 34 * ref
		}
		drawWrappedText(img, a.Text, cx, cy, hw*2-rad, size, hexColor(a.TextColor, "#ffffff"))

	default:
		return errUnknownAnnotation
	}
	return nil
}

// drawCentredText puts a single line's optical centre at (cx,cy).
func drawCentredText(img *image.RGBA, s string, cx, cy, size float64, c color.NRGBA) {
	if strings.TrimSpace(s) == "" || size <= 0 {
		return
	}
	face, err := newFace(size)
	if err != nil {
		return
	}
	defer face.Close()
	tw := textWidth(face, s)
	// Baseline sits below the centre by roughly a third of the cap height; the
	// same approximation captions and titles use.
	drawString(img, face, s, int(cx)-tw/2, int(cy+size*0.35), c)
}

// drawWrappedText centres a wrapped block of text on (cx,cy).
func drawWrappedText(img *image.RGBA, s string, cx, cy, maxW, size float64, c color.NRGBA) {
	if strings.TrimSpace(s) == "" || size <= 0 {
		return
	}
	face, err := newFace(size)
	if err != nil {
		return
	}
	defer face.Close()
	lines := wrapText(s, face, int(math.Max(maxW, size)))
	if len(lines) == 0 {
		return
	}
	lineH := size * 1.3
	top := cy - lineH*float64(len(lines))/2
	for i, ln := range lines {
		tw := textWidth(face, ln)
		drawString(img, face, ln, int(cx)-tw/2, int(top+lineH*float64(i)+size*0.9), c)
	}
}
