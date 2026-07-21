package render

import (
	"math"
	"sort"

	"studio/internal/schema"
)

// Numeric keyframe evaluation.
//
// The rest of the renderer compiles keyframes into ffmpeg *expressions*, which
// is right for anything ffmpeg evaluates per frame. Cursor overlays need the
// other thing: a concrete value at a concrete instant, computed here, because
// each pointer sample has to be transformed through whatever the clip's zoom
// and pan were doing at that moment before it becomes a sendcmd entry.
//
// easeValue mirrors easeProgress shape for shape. They must agree — one is the
// numeric twin of the other, and a divergence would put the cursor overlays
// somewhere the clip they belong to is not.

func easeValue(ease string, p float64) float64 {
	x := clampF(p, 0, 1)
	switch ease {
	case "easeInCubic":
		return x * x * x
	case "easeOutCubic":
		return 1 - math.Pow(1-x, 3)
	case "easeInOut": // quintic smootherstep
		return x * x * x * (x*(x*6-15) + 10)
	case "easeOutBack":
		return 1 + 2.70158*math.Pow(x-1, 3) + 1.70158*math.Pow(x-1, 2)
	case "easeOutElastic":
		if x == 0 || x == 1 {
			return x
		}
		return math.Pow(2, -10*x)*math.Sin((x*10-0.75)*2.0943951) + 1
	case "springOut":
		if x <= 0 {
			return 0
		}
		if x >= 1 {
			return 1
		}
		return 1 + math.Pow(2, -9*x)*math.Sin((x*8-0.75)*1.8479957)*0.9
	default:
		return x
	}
}

// kfValueAt interpolates keyframes at clip-local time t, holding the end values
// outside the keyed range — the same piecewise shape kfPiecewise compiles.
func kfValueAt(kfs []schema.Keyframe, t float64) float64 {
	if len(kfs) == 0 {
		return 0
	}
	pts := append([]schema.Keyframe(nil), kfs...)
	sort.SliceStable(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	if t <= pts[0].T {
		return pts[0].Value
	}
	last := pts[len(pts)-1]
	if t >= last.T {
		return last.Value
	}
	for i := 0; i < len(pts)-1; i++ {
		a, b := pts[i], pts[i+1]
		if t < b.T {
			dt := math.Max(b.T-a.T, 1e-3)
			return a.Value + (b.Value-a.Value)*easeValue(a.Ease, (t-a.T)/dt)
		}
	}
	return last.Value
}

// clipBoxAt is where a clip's content actually sits on the canvas at timeline
// time t: its top-left corner and its drawn size.
//
// This is the same geometry the overlay chain produces — anchor-relative
// placement plus the keyed offsets — reproduced numerically so overlays that
// must ride along with the clip can be positioned in the same space.
func clipBoxAt(v *visual, w, h int, t float64) (left, top, cw, ch float64) {
	local := t - v.start

	scale := float64(v.sw) / float64(w)
	if kf := v.keyframes["scale"]; len(kf) > 0 {
		scale = math.Max(0, kfValueAt(kf, local))
	}
	cw = float64(w) * scale
	ch = float64(h) * scale

	// Static x/y already include the anchored base; keyed ones are offsets from
	// it, matching how the filtergraph composes the two.
	offX := float64(v.x - v.cx)
	offY := float64(v.y - v.cy)
	if kf := v.keyframes["x"]; len(kf) > 0 {
		offX = kfValueAt(kf, local)
	}
	if kf := v.keyframes["y"]; len(kf) > 0 {
		offY = kfValueAt(kf, local)
	}

	left = v.ax*(float64(w)-cw) + offX
	top = v.ay*(float64(h)-ch) + offY
	return left, top, cw, ch
}
