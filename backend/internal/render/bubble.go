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
Webcam bubbles — the camera feed as a floating circle (or rounded card) with a
border ring and a soft shadow, the way every modern tutorial frames a face.

Same architecture as device frames and backdrops: composited at CANVAS size
before the clip's transform, so the clip's ordinary x/y/scale — and their
keyframes — place the bubble. The panel's corner buttons are nothing more than
writes to the transform, which is why a snapped bubble can still be dragged,
keyframed, or flown in like any clip.

The geometry lives in bubbleLayout and is golden-tested in both languages
(frontend/src/bubble.ts): the preview positions a DOM node onto exactly the
rectangle the exporter composites into.
*/

const (
	bubbleDefSize   = 0.28 // diameter as a fraction of canvas height
	bubbleMaxSize   = 0.9
	bubbleDefBorder = 6.0 // px at 1080-high reference
	bubbleDefShadow = 0.5
	// The rounded card's corner radius, as a fraction of the diameter.
	bubbleCardRadius = 0.18
)

type bubbleGeom struct {
	d      int     // diameter (the bubble is square), canvas px, even
	x, y   int     // top-left when centred on the canvas
	radius float64 // corner radius in canvas px (d/2 for a circle)
	border float64 // ring width in canvas px (0 = none)
}

func bubbleLayout(b *schema.Bubble, w, h int) bubbleGeom {
	size := b.Size
	if size == 0 {
		size = bubbleDefSize
	}
	size = clampF(size, 0.05, bubbleMaxSize)
	d := even(float64(h) * size)
	radius := float64(d) / 2
	if b.Shape == "rounded" {
		radius = float64(d) * bubbleCardRadius
	}
	border := b.Border
	if border == 0 {
		border = bubbleDefBorder
	}
	if border < 0 {
		border = 0
	}
	return bubbleGeom{
		d:      d,
		x:      even((float64(w) - float64(d)) / 2),
		y:      even((float64(h) - float64(d)) / 2),
		radius: radius,
		border: border * float64(h) / 1080,
	}
}

// renderBubbleFramePNG draws the shadow and the border ring on one
// canvas-sized transparent sheet, laid OVER the placed picture. That works
// because neither overlaps the picture: the shadow lives outside the mask's
// radius and the ring straddles its edge — so paint order between them and the
// picture cannot show.
func renderBubbleFramePNG(b *schema.Bubble, g bubbleGeom, w, h int, outPath string) error {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	cx := float64(g.x) + float64(g.d)/2
	cy := float64(g.y) + float64(g.d)/2
	hw := float64(g.d) / 2

	shadow := b.Shadow
	if shadow == 0 {
		shadow = bubbleDefShadow
	}
	if shadow > 0 {
		s := clampF(shadow, 0, 1)
		blur := float64(h) * 0.025
		dark := color.NRGBA{R: 0, G: 0, B: 0, A: 255}
		off := float64(h) * 0.008
		pad := blur * 5
		r := boxAround(float64(g.x)-pad, float64(g.y)-pad, float64(g.x+g.d)+pad, float64(g.y+g.d)+pad, 2).Intersect(img.Bounds())
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				d := sdRoundRect(float64(x)+0.5, float64(y)+0.5, cx, cy+off, hw, hw, g.radius)
				if d <= 0 {
					continue // under the picture; invisible, skip the work
				}
				a := 0.4 * s * math.Exp(-d/blur)
				if a > 1.0/255 {
					over(img, x, y, dark, a)
				}
			}
		}
	}

	if g.border > 0 {
		ring := hexColor(b.BorderColor, "#ffffff")
		half := g.border / 2
		r := boxAround(float64(g.x)-g.border, float64(g.y)-g.border, float64(g.x+g.d)+g.border, float64(g.y+g.d)+g.border, 2).Intersect(img.Bounds())
		for y := r.Min.Y; y < r.Max.Y; y++ {
			for x := r.Min.X; x < r.Max.X; x++ {
				// |distance to the outline| < half-width = on the ring.
				d := math.Abs(sdRoundRect(float64(x)+0.5, float64(y)+0.5, cx, cy, hw, hw, g.radius)) - half
				cov := coverage(d)
				if cov > 0 {
					over(img, x, y, ring, cov)
				}
			}
		}
	}
	return encodePNG(outPath, img)
}

// renderBubbleMaskPNG is the bubble's alpha, reusing the backdrop's rounded
// mask — a circle is a rounded rect whose radius is half its size.
func renderBubbleMaskPNG(g bubbleGeom, outPath string) error {
	return renderBackdropMaskPNG(backdropGeom{w: g.d, h: g.d, radius: g.radius}, outPath)
}

/*
writeBubble centre-crops the picture square, masks it, places it on a
transparent canvas at the layout's position, and lays the frame (shadow +
ring) over it. The centre crop is what makes a 16:9 camera fill a circle
instead of arriving letterboxed inside it.
*/
func writeBubble(fc *strings.Builder, in string, i, maskIdx, frameIdx int, g bubbleGeom, w, h int) string {
	pic := fmt.Sprintf("[bbp%d]", i)
	msk := fmt.Sprintf("[bbm%d]", i)
	cut := fmt.Sprintf("[bbc%d]", i)
	placed := fmt.Sprintf("[bbl%d]", i)
	frame := fmt.Sprintf("[bbf%d]", i)
	out := fmt.Sprintf("[bb%d]", i)

	fmt.Fprintf(fc,
		"%scrop='min(iw,ih)':'min(iw,ih)',scale=%d:%d:flags=bicubic,format=rgba%s;",
		in, g.d, g.d, pic)
	fmt.Fprintf(fc, "[%d:v]format=gray%s;", maskIdx, msk)
	fmt.Fprintf(fc, "%s%salphamerge%s;", pic, msk, cut)
	fmt.Fprintf(fc, "%spad=%d:%d:%d:%d:color=black@0%s;", cut, w, h, g.x, g.y, placed)
	fmt.Fprintf(fc, "[%d:v]format=rgba%s;", frameIdx, frame)
	fmt.Fprintf(fc, "%s%soverlay=0:0:format=auto%s;", placed, frame, out)
	return out
}
