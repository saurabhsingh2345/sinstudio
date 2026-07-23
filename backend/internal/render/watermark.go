package render

import (
	"math"

	"studio/internal/schema"
)

// Watermark layout — where the brand mark sits, in canvas pixels. The twin of
// frontend/src/watermark.ts; golden-tested on both sides like every other
// piece of shared geometry.

const (
	watermarkDefSize    = 0.12
	watermarkDefOpacity = 0.6
	watermarkDefMargin  = 0.03
)

type watermarkGeom struct {
	x, y, w, h int
}

func watermarkOpacity(wm *schema.Watermark) float64 {
	if wm.Opacity == 0 {
		return watermarkDefOpacity
	}
	return clampF(wm.Opacity, 0.05, 1)
}

// watermarkLayout sizes the mark by canvas width, keeps the image's own
// aspect, and tucks it into the chosen corner. Unknown image dims are treated
// as square — wrong aspect beats no watermark.
func watermarkLayout(wm *schema.Watermark, imgW, imgH, w, h int) watermarkGeom {
	size := wm.Size
	if size == 0 {
		size = watermarkDefSize
	}
	size = clampF(size, 0.02, 0.5)
	if imgW <= 0 || imgH <= 0 {
		imgW, imgH = 1, 1
	}
	ww := even(float64(w) * size)
	wh := even(float64(ww) * float64(imgH) / float64(imgW))
	margin := wm.Margin
	if margin == 0 {
		margin = watermarkDefMargin
	}
	m := int(math.Round(clampF(margin, 0, 0.2) * math.Min(float64(w), float64(h))))
	g := watermarkGeom{w: ww, h: wh}
	switch wm.Corner {
	case "tl":
		g.x, g.y = m, m
	case "tr":
		g.x, g.y = w-ww-m, m
	case "bl":
		g.x, g.y = m, h-wh-m
	default: // br
		g.x, g.y = w-ww-m, h-wh-m
	}
	return g
}
