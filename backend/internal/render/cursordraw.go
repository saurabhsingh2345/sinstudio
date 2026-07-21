package render

import (
	"image"
	"image/color"
	"math"

	"golang.org/x/image/vector"

	"studio/internal/cursor"
)

// Drawing Studio's own pointer, and smoothing the path it follows.
//
// Both only become possible once the OS cursor is kept out of the capture. With
// a cursor burned into the pixels there is nothing to smooth — the recorded
// cursor stays exactly where it was, and any drawn one just doubles it.

const (
	defPointerSize  = 44
	defPointerColor = "#ffffff"
)

// arrowPath is the classic pointer outline in a unit box, tip at the origin.
// Keeping the tip at (0,0) means the image's top-left IS the hotspot, so
// positioning it needs no offset — unlike the disc effects, which centre.
var arrowPath = [][2]float64{
	{0.00, 0.00},
	{0.00, 1.00},
	{0.26, 0.75},
	{0.42, 1.12},
	{0.60, 1.04},
	{0.44, 0.68},
	{0.72, 0.66},
}

// rasterize fills a polygon into an alpha mask with anti-aliased edges.
func rasterize(w, h int, pts [][2]float64, scale, offX, offY float64) *image.Alpha {
	r := vector.NewRasterizer(w, h)
	r.MoveTo(float32(pts[0][0]*scale+offX), float32(pts[0][1]*scale+offY))
	for _, p := range pts[1:] {
		r.LineTo(float32(p[0]*scale+offX), float32(p[1]*scale+offY))
	}
	r.ClosePath()
	dst := image.NewAlpha(image.Rect(0, 0, w, h))
	r.Draw(dst, dst.Bounds(), image.Opaque, image.Point{})
	return dst
}

// writePointerPNG draws the cursor and returns its hotspot — the point in the
// image that sits exactly on the recorded coordinate.
func writePointerPNG(path, style string, size int, c color.NRGBA, opacity float64) (imgW, imgH, hotX, hotY int, err error) {
	if size < 8 {
		size = 8
	}
	op := clampF(opacity, 0, 1)
	if op == 0 {
		op = 1
	}

	switch style {
	case "dot", "ring":
		// A round pointer is its own hotspot: dead centre.
		img := image.NewNRGBA(image.Rect(0, 0, size, size))
		r := float64(size) / 2
		inner := 0.0
		if style == "ring" {
			inner = r * 0.55
		}
		for y := 0; y < size; y++ {
			for x := 0; x < size; x++ {
				d := math.Hypot(float64(x)+0.5-r, float64(y)+0.5-r)
				// A dark rim keeps a light pointer legible on light content and
				// vice versa; without it the cursor vanishes over its own colour.
				var a float64
				var col color.NRGBA
				switch {
				case d <= r-3 && d >= inner:
					a, col = 1, c
				case d <= r && d >= inner-2:
					a, col = clampF(r-d, 0, 1), color.NRGBA{0, 0, 0, 255}
				}
				if a <= 0 {
					continue
				}
				img.SetNRGBA(x, y, color.NRGBA{col.R, col.G, col.B, uint8(a * op * 255)})
			}
		}
		return size, size, size / 2, size / 2, encodePNG(path, img)
	}

	// Arrow. The outline is the fill dilated in every direction rather than a
	// scaled-up copy of the shape: scaling a polygon moves it away from its own
	// origin, so the "outline" ends up beside the fill instead of around it.
	// Same 8-direction trick the caption renderer uses for text.
	scale := float64(size)
	stroke := math.Max(1.5, scale*0.055)
	w := int(scale*0.8+stroke*2) + 2
	h := int(scale*1.12+stroke*2) + 2

	fill := rasterize(w, h, arrowPath, scale, stroke, stroke)

	// Dilate: a pixel is outline if any pixel within `stroke` is fill.
	st := int(math.Ceil(stroke))
	outline := image.NewAlpha(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			var best uint8
			for dy := -st; dy <= st && best < 255; dy++ {
				for dx := -st; dx <= st && best < 255; dx++ {
					if dx*dx+dy*dy > st*st {
						continue
					}
					px, py := x+dx, y+dy
					if px < 0 || py < 0 || px >= w || py >= h {
						continue
					}
					if a := fill.AlphaAt(px, py).A; a > best {
						best = a
					}
				}
			}
			outline.SetAlpha(x, y, color.Alpha{A: best})
		}
	}

	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			fa := float64(fill.AlphaAt(x, y).A) / 255
			oa := float64(outline.AlphaAt(x, y).A) / 255
			if fa <= 0 && oa <= 0 {
				continue
			}
			// White (or the chosen colour) over black, so the silhouette stays
			// legible on light and dark content alike.
			rr := float64(c.R) * fa
			gg := float64(c.G) * fa
			bb := float64(c.B) * fa
			a := math.Max(fa, oa) * op
			img.SetNRGBA(x, y, color.NRGBA{uint8(rr), uint8(gg), uint8(bb), uint8(clampF(a, 0, 1) * 255)})
		}
	}
	// The tip is the fill's origin, which the stroke inset pushed in.
	return w, h, st, st, encodePNG(path, img)
}

// smoothPath irons jitter out of a recorded pointer path.
//
// The window is measured in TIME, not samples. The sampler emits densely while
// the pointer moves and sparsely while it rests, so a fixed sample-count window
// would smooth a fast flick barely at all and a slow drift enormously — exactly
// backwards.
//
// Clicks are anchors. A click is a claim about a specific pixel, and a path
// that drifts off the button being clicked is worse than a shaky one, so
// smoothing fades out around every press and the cursor passes through the real
// position at the moment it mattered.
func smoothPath(samples []cursor.Sample, intensity float64) []cursor.Sample {
	n := len(samples)
	if n < 3 || intensity <= 0 {
		return samples
	}
	window := clampF(intensity, 0, 1) * 260 // ms at full strength
	if window < 1 {
		return samples
	}
	const anchorMS = 220.0 // how close to a click before smoothing lets go

	// Press edges, for anchoring.
	var clicks []int64
	var prev uint8
	for _, s := range samples {
		if s.Down != 0 && prev == 0 {
			clicks = append(clicks, s.T)
		}
		prev = s.Down
	}
	nearestClick := func(t int64) float64 {
		best := math.MaxFloat64
		for _, ct := range clicks {
			if d := math.Abs(float64(t - ct)); d < best {
				best = d
			}
		}
		return best
	}

	out := make([]cursor.Sample, n)
	copy(out, samples)
	for i, s := range samples {
		var sx, sy, wsum float64
		for j := i; j >= 0; j-- {
			d := float64(s.T - samples[j].T)
			if d > window {
				break
			}
			w := 1 - d/window
			sx += float64(samples[j].X) * w
			sy += float64(samples[j].Y) * w
			wsum += w
		}
		for j := i + 1; j < n; j++ {
			d := float64(samples[j].T - s.T)
			if d > window {
				break
			}
			w := 1 - d/window
			sx += float64(samples[j].X) * w
			sy += float64(samples[j].Y) * w
			wsum += w
		}
		if wsum <= 0 {
			continue
		}
		// Blend toward the raw position as a click approaches.
		blend := 1.0
		if len(clicks) > 0 {
			if d := nearestClick(s.T); d < anchorMS {
				blend = d / anchorMS
			}
		}
		out[i].X = int(float64(s.X)*(1-blend) + (sx/wsum)*blend)
		out[i].Y = int(float64(s.Y)*(1-blend) + (sy/wsum)*blend)
	}
	return out
}
