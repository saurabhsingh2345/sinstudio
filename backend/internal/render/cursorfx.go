package render

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"

	"studio/internal/cursor"
	"studio/internal/schema"
)

// Cursor emphasis — highlight, click rings and spotlight — for a clip whose
// asset has a recorded pointer track beside it.
//
// The naive implementation is a frame-by-frame pass that draws over every
// frame. This renderer has no such pass and shouldn't grow one: it compiles the
// whole timeline into a single filtergraph, and a decode/draw/encode stage
// would cost more than everything else combined.
//
// None of these effects actually need one. Each is a *static* image moved
// around: a disc that follows the pointer, a ring that expands where it was
// clicked, a dimming mask with a hole punched in it. So each becomes one PNG
// plus an overlay — which is exactly what the existing pipeline already does
// with titles and captions.
//
// The one thing that doesn't fit is *how* the position is driven. kfExpr builds
// a nested if() per keyframe, and a pointer track has thousands of samples; that
// expression would be thousands of levels deep. sendcmd takes a flat list of
// timed commands instead, targeted at a named filter instance (overlay@cur), so
// cost is linear in samples rather than nested in them.

const (
	defHighlightSize    = 96
	defHighlightColor   = "#ffcc33"
	defHighlightOpacity = 0.35

	defClickSize     = 140
	defClickColor    = "#ffffff"
	defClickDuration = 0.45

	defSpotRadius = 220
	defSpotDim    = 0.55
)

// maxClickRings bounds how many rings one clip contributes. Each ring is an
// extra input and overlay in the graph, and a filtergraph that grows without
// limit eventually fails to build at all. A recording with hundreds of clicks
// is a long one; the first few hundred rings carry the point.
const maxClickRings = 200

// cursorPlan is the compiled result for one clip.
type cursorPlan struct {
	cmds     []string // sendcmd entries driving the highlight/spotlight
	segments []cursorSegment
}

// cursorSegment is one overlay to splice onto the chain after the clip itself.
type cursorSegment struct {
	png       string // image to overlay, appended as its own -i
	name      string // filter instance name, e.g. "hl0" → overlay@hl0
	x, y      string // overlay position expressions
	enable    string // enable='...' window
	scaleExpr string // optional animated scale, in timeline time
	// A named scale filter whose w/h sendcmd drives, so the overlay grows with
	// the clip it marks. Empty leaves the image at its authored size.
	scaleName    string
	baseW, baseH int
	// Alpha ramp for a click ring, as a fade rather than a geq expression:
	// geq evaluates per pixel per frame, which is the most expensive way to
	// do the cheapest thing here.
	fadeStart float64
	fadeDur   float64
}

func hexColor(s, fallback string) color.NRGBA {
	if s == "" {
		s = fallback
	}
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(s) == 3 {
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	}
	if len(s) != 6 {
		return color.NRGBA{255, 204, 51, 255}
	}
	var r, g, b uint8
	fmt.Sscanf(s, "%02x%02x%02x", &r, &g, &b)
	return color.NRGBA{r, g, b, 255}
}

// writeDiscPNG draws a filled circle with a soft edge. The falloff is what
// keeps a highlight from reading as a hard sticker pasted on the screen.
func writeDiscPNG(path string, size int, c color.NRGBA, opacity float64, feather float64) error {
	if size < 2 {
		size = 2
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	r := float64(size) / 2
	soft := r * feather
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			d := math.Hypot(float64(x)+0.5-r, float64(y)+0.5-r)
			var a float64
			switch {
			case d <= r-soft:
				a = 1
			case d >= r:
				a = 0
			default:
				a = (r - d) / soft
			}
			if a <= 0 {
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{c.R, c.G, c.B, uint8(clampF(a*opacity, 0, 1) * 255)})
		}
	}
	return encodePNG(path, img)
}

// writeRingPNG draws an annulus — the click ring at its final size, which the
// filtergraph then scales up from nothing and fades out.
func writeRingPNG(path string, size int, c color.NRGBA, thickness float64) error {
	if size < 4 {
		size = 4
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	outer := float64(size) / 2
	inner := outer * (1 - thickness)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			d := math.Hypot(float64(x)+0.5-outer, float64(y)+0.5-outer)
			if d > outer || d < inner {
				continue
			}
			// Fade both edges so the ring has no aliased boundary.
			edge := math.Min(outer-d, d-inner)
			a := clampF(edge/2, 0, 1)
			img.SetNRGBA(x, y, color.NRGBA{c.R, c.G, c.B, uint8(a * 255)})
		}
	}
	return encodePNG(path, img)
}

// writeSpotMaskPNG draws the dimming layer: opaque everywhere except a hole in
// the middle. It is twice the canvas in each dimension so that, wherever the
// hole is placed over the frame, the dimmed area still covers the whole thing —
// with the hole centred, the mask reaches canvas-width past every edge.
func writeSpotMaskPNG(path string, w, h, radius int, dim float64) error {
	mw, mh := w*2, h*2
	img := image.NewNRGBA(image.Rect(0, 0, mw, mh))
	cx, cy := float64(mw)/2, float64(mh)/2
	rr := float64(radius)
	soft := rr * 0.45 // wide falloff; a hard edge reads as a black donut
	a0 := clampF(dim, 0, 1) * 255
	for y := 0; y < mh; y++ {
		for x := 0; x < mw; x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			var f float64
			switch {
			case d <= rr:
				f = 0
			case d >= rr+soft:
				f = 1
			default:
				f = (d - rr) / soft
			}
			if f <= 0 {
				continue
			}
			img.SetNRGBA(x, y, color.NRGBA{0, 0, 0, uint8(f * a0)})
		}
	}
	return encodePNG(path, img)
}

func encodePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func clampF(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// cmdTime reads the leading timestamp of a sendcmd entry, for ordering. A line
// that somehow has none sorts first, which is harmless: sendcmd only cares that
// times ascend.
func cmdTime(line string) float64 {
	var t float64
	if _, err := fmt.Sscanf(strings.TrimSpace(line), "%f", &t); err != nil {
		return 0
	}
	return t
}

// sendcmdEscape quotes a value for a sendcmd script. Commas separate commands
// and semicolons terminate them, so any appearing in an argument must not read
// as syntax.
func sendcmdEscape(s string) string {
	r := strings.NewReplacer(",", `\,`, ";", `\;`, "'", `\'`)
	return r.Replace(s)
}

// buildCursorFX compiles a clip's cursor effects into PNGs plus a sendcmd
// script.
//
// Track coordinates are in the recording's own pixel space, and the recording
// is drawn wherever the clip's transform puts it — which moves and grows over
// time once anything is keyframed. Every sample is therefore mapped through the
// clip's box at its own instant (see cursorCommands), not through a fixed
// canvas ratio.
func buildCursorFX(
	fx *schema.CursorFX,
	track *cursor.Track,
	dir string,
	idx int,
	v *visual,
	canvasW, canvasH int,
) (*cursorPlan, error) {
	start, end := v.start, v.end
	if fx == nil || track == nil || len(track.Samples) == 0 {
		return nil, nil
	}
	// Smooth once, up front, so every effect agrees on where the pointer is.
	// A drawn cursor on a smoothed path with a highlight on the raw one would
	// visibly separate the two.
	if p := fx.Pointer; p != nil && p.Smoothing > 0 && track.Hidden {
		smoothed := *track
		smoothed.Samples = smoothPath(track.Samples, p.Smoothing)
		track = &smoothed
	}
	dur := end - start

	plan := &cursorPlan{}
	var cmds []string

	// Spotlight is drawn first so the highlight and rings sit on top of the dim
	// rather than under it.
	if sp := fx.Spotlight; sp != nil {
		radius := sp.Radius
		if radius <= 0 {
			radius = defSpotRadius
		}
		dim := sp.Dim
		if dim <= 0 {
			dim = defSpotDim
		}
		p := filepath.Join(dir, fmt.Sprintf("cur-%d-spot.png", idx))
		if err := writeSpotMaskPNG(p, canvasW, canvasH, radius, dim); err != nil {
			return nil, err
		}
		name := fmt.Sprintf("spot%d", idx)
		plan.segments = append(plan.segments, cursorSegment{
			png:    p,
			name:   name,
			x:      fmt.Sprintf("%d", -canvasW/2),
			y:      fmt.Sprintf("%d", -canvasH/2),
			enable: fmt.Sprintf("between(t,%.3f,%.3f)", start, end),
		})
		cmds = append(cmds, cursorCommands(v, track, name, canvasW, canvasH, dur, canvasW, canvasH, 0, 0)...)
	}

	if hl := fx.Highlight; hl != nil {
		size := hl.Size
		if size <= 0 {
			size = defHighlightSize
		}
		op := hl.Opacity
		if op <= 0 {
			op = defHighlightOpacity
		}
		p := filepath.Join(dir, fmt.Sprintf("cur-%d-hl.png", idx))
		if err := writeDiscPNG(p, size, hexColor(hl.Color, defHighlightColor), op, 0.35); err != nil {
			return nil, err
		}
		name := fmt.Sprintf("hl%d", idx)
		plan.segments = append(plan.segments, cursorSegment{
			png:    p,
			name:   name,
			x:      fmt.Sprintf("%d", -size/2),
			y:      fmt.Sprintf("%d", -size/2),
			enable: fmt.Sprintf("between(t,%.3f,%.3f)", start, end),
		})
		seg := &plan.segments[len(plan.segments)-1]
		seg.scaleName = name
		seg.baseW, seg.baseH = size, size
		cmds = append(cmds, cursorCommands(v, track, name, canvasW, canvasH, dur, size/2, size/2, size, size)...)
	}

	// Click rings need no sendcmd: a click happens at one point, so each ring is
	// a static overlay enabled for its own window. Only the size animates.
	if ck := fx.Clicks; ck != nil {
		size := ck.Size
		if size <= 0 {
			size = defClickSize
		}
		rd := ck.Duration
		if rd <= 0 {
			rd = defClickDuration
		}
		times := track.ClickTimes()
		if len(times) > maxClickRings {
			times = times[:maxClickRings]
		}
		if len(times) > 0 {
			p := filepath.Join(dir, fmt.Sprintf("cur-%d-ring.png", idx))
			if err := writeRingPNG(p, size, hexColor(ck.Color, defClickColor), 0.18); err != nil {
				return nil, err
			}
			for i, ct := range times {
				if ct < 0 || ct > dur {
					continue
				}
				cx, cy := track.At(ct)
				at := start + ct
				// A ring lives under half a second, so the clip's zoom at the
				// moment of the click is a fair constant for its whole life —
				// no need to command it per frame like the tracking overlays.
				left, top, cw, ch := clipBoxAt(v, canvasW, canvasH, at)
				z := 1.0
				if canvasW > 0 {
					z = cw / float64(canvasW)
				}
				bx, by, bw, bh := contentFracFor(v, track.Video.Width, track.Video.Height, canvasW, canvasH)
				px := left + (bx+float64(cx)/math.Max(1, float64(track.Video.Width))*bw)*cw
				py := top + (by+float64(cy)/math.Max(1, float64(track.Video.Height))*bh)*ch
				ringSize := int(float64(size) * z)
				// Grow from a quarter size to full over the ring's life while
				// fading out — the shape a click reads as. Both run on timeline
				// time, which is why the still's PTS is shifted to the clip.
				prog := fmt.Sprintf("clip((t-%.3f)/%.3f,0,1)", at, rd)
				plan.segments = append(plan.segments, cursorSegment{
					png:       p,
					name:      fmt.Sprintf("ring%d_%d", idx, i),
					scaleExpr: fmt.Sprintf("%d*(0.25+0.75*%s)", maxInt(2, ringSize), prog),
					fadeStart: at,
					fadeDur:   rd,
					x:         fmt.Sprintf("%.1f-w/2", px),
					y:         fmt.Sprintf("%.1f-h/2", py),
					enable:    fmt.Sprintf("between(t,%.3f,%.3f)", at, at+rd),
				})
			}
		}
	}

	// The drawn pointer goes last so it sits above every emphasis effect — a
	// highlight painted over the cursor would defeat the purpose.
	//
	// Gated on track.Hidden: without it the capture already contains a cursor,
	// and a second one would track along beside the first.
	if p := fx.Pointer; p != nil && track.Hidden {
		size := p.Size
		if size <= 0 {
			size = defPointerSize
		}
		pp := filepath.Join(dir, fmt.Sprintf("cur-%d-ptr.png", idx))
		ptrW, ptrH, hotX, hotY, err := writePointerPNG(pp, p.Style, size, hexColor(p.Color, defPointerColor), p.Opacity)
		if err != nil {
			return nil, err
		}
		name := fmt.Sprintf("ptr%d", idx)
		plan.segments = append(plan.segments, cursorSegment{
			png:    pp,
			name:   name,
			x:      fmt.Sprintf("%d", -hotX),
			y:      fmt.Sprintf("%d", -hotY),
			enable: fmt.Sprintf("between(t,%.3f,%.3f)", start, end),
		})
		seg := &plan.segments[len(plan.segments)-1]
		seg.scaleName = name
		seg.baseW, seg.baseH = ptrW, ptrH
		cmds = append(cmds, cursorCommands(v, track, name, canvasW, canvasH, dur, hotX, hotY, ptrW, ptrH)...)
	}

	plan.cmds = cmds
	if len(plan.segments) == 0 {
		return nil, nil
	}
	return plan, nil
}

// contentFrac says where a fitted source's picture sits inside the
// canvas-shaped clip box, as fractions of the box: x0/y0 offset, fw/fh extent.
//
// A recording whose shape is not the canvas's is fitted with bars (see the
// prefit in render.go), so "fraction of the video" and "fraction of the box"
// stop being the same number — and a cursor mapped by the naive fraction drifts
// off its target toward the edges, worst exactly where the bars are. The
// half-percent tolerance mirrors the prefit's: below it the stream really is
// stretched, and the naive fraction is the exact answer.
//
// The same geometry lives in the frontend's contentBox (zoomPan.ts); they must
// agree or preview and export place effects differently.
func contentFrac(vw, vh, w, h int) (x0, y0, fw, fh float64) {
	x0, y0, fw, fh = 0, 0, 1, 1
	if vw <= 0 || vh <= 0 || w <= 0 || h <= 0 {
		return
	}
	srcA := float64(vw) / float64(vh)
	canA := float64(w) / float64(h)
	if math.Abs(srcA-canA)/canA <= 0.005 {
		return
	}
	k := math.Min(float64(w)/float64(vw), float64(h)/float64(vh))
	fw = float64(vw) * k / float64(w)
	fh = float64(vh) * k / float64(h)
	x0 = (1 - fw) / 2
	y0 = (1 - fh) / 2
	return
}

// contentFracFor is contentFrac, aware that a backdrop pulls the picture in
// from the edges — the pointer track's coordinates are in the recording's
// pixels, and with a backdrop those pixels occupy the card, not the box.
// (Under a device frame the picture moves too, but cursor effects there were
// already unmapped before backdrops existed; the device screen inset is a
// separate, pre-existing gap.)
func contentFracFor(v *visual, vw, vh, w, h int) (x0, y0, fw, fh float64) {
	if v.backdrop != nil && v.device == nil && w > 0 && h > 0 {
		g := backdropLayout(v.backdrop, vw, vh, w, h)
		return float64(g.x) / float64(w), float64(g.y) / float64(h),
			float64(g.w) / float64(w), float64(g.h) / float64(h)
	}
	return contentFrac(vw, vh, w, h)
}

// cursorCommands emits one sendcmd entry per sample, positioning a named
// overlay so its hotspot (offX/offY from its top-left, at unit scale) sits on
// the pointer.
//
// Every sample is transformed through the clip's OWN box at that instant. The
// overlays composite onto the canvas, but the pointer's coordinates are in the
// recording's frame — and that frame moves and grows whenever the clip is
// zoomed or panned, which is exactly what auto-zoom does. Positioning in flat
// canvas space instead leaves every highlight sitting on whatever content
// happens to have slid under it.
//
// Sizes ride along too: content magnified 2x should carry a cursor and
// highlight magnified with it, or they shrink relative to what they mark.
func cursorCommands(v *visual, track *cursor.Track, name string, w, h int, dur float64, hotX, hotY int, sizeW, sizeH int) []string {
	out := make([]string, 0, len(track.Samples))
	var lastX, lastY, lastW int
	var have bool
	bx, by, bw, bh := contentFracFor(v, track.Video.Width, track.Video.Height, w, h)
	for _, s := range track.Samples {
		ts := float64(s.T) / 1000
		if ts < 0 || ts > dur {
			continue
		}
		left, top, cw, ch := clipBoxAt(v, w, h, v.start+ts)
		fx := 0.0
		fy := 0.0
		if track.Video.Width > 0 {
			fx = bx + float64(s.X)/float64(track.Video.Width)*bw
		}
		if track.Video.Height > 0 {
			fy = by + float64(s.Y)/float64(track.Video.Height)*bh
		}
		// Zoom factor relative to a canvas-filling clip, so a 1:1 clip leaves
		// the overlays at their authored size.
		z := 1.0
		if w > 0 {
			z = cw / float64(w)
		}
		px := left + fx*cw
		py := top + fy*ch
		x := int(px - float64(hotX)*z)
		y := int(py - float64(hotY)*z)

		var cmds string
		sw := int(float64(sizeW) * z)
		sh := int(float64(sizeH) * z)
		if sizeW > 0 && sw != lastW {
			cmds = fmt.Sprintf(", scale@%s w %d, scale@%s h %d",
				sendcmdEscape(name), maxInt(2, sw), sendcmdEscape(name), maxInt(2, sh))
			lastW = sw
		} else if have && x == lastX && y == lastY {
			// The sampler's heartbeat repeats a stationary position every 250ms;
			// re-issuing an unchanged command just makes the script bigger.
			continue
		}
		out = append(out, fmt.Sprintf("%.3f overlay@%s x %d, overlay@%s y %d%s;",
			v.start+ts, sendcmdEscape(name), x, sendcmdEscape(name), y, cmds))
		lastX, lastY, have = x, y, true
	}
	return out
}
