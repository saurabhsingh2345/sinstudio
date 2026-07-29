package render

import (
	"fmt"
	"strings"

	"studio/internal/cursor"
	"studio/internal/schema"
)

/*
Cropping a clip's own picture.

The crop is compiled in one place and everything downstream is told the smaller
size, rather than the crop being a special case each later stage has to know
about. That matters more than it sounds: the prefit that letterboxes a
mismatched source, the pan clamp that keeps a zoom inside the content, the
backdrop card's geometry and the cursor track's coordinate space are four
separate pieces of arithmetic that all take "the source's dimensions" as an
input. Cropping without updating that input produces four different kinds of
wrong at once — bars beside a picture that no longer needs them, a zoom that
clamps against a frame that is not there, and a pointer drawn where it was
before the top of the screen was cut off.

So: croppedDims is the single answer to "how big is this clip's picture", and it
is asked before any of them.
*/

// croppedDims is the source's size after its crop. Zero in means zero out — an
// asset whose dimensions were never probed stays unknown rather than becoming
// a confident 2x2.
func croppedDims(srcW, srcH int, c *schema.Crop) (int, int) {
	if srcW <= 0 || srcH <= 0 || c.Empty() {
		return srcW, srcH
	}
	_, _, w, h := c.Pixels(srcW, srcH)
	return w, h
}

// cropFilter is the ffmpeg segment, with a trailing comma so it can be spliced
// into a chain, or "" when there is nothing to trim.
func cropFilter(c *schema.Crop, srcW, srcH int) string {
	if c.Empty() || srcW <= 0 || srcH <= 0 {
		return ""
	}
	x, y, w, h := c.Pixels(srcW, srcH)
	if w >= srcW && h >= srcH {
		return ""
	}
	return fmt.Sprintf("crop=%d:%d:%d:%d,", w, h, x, y)
}

// trimComma drops the trailing separator a filter segment carries for splicing
// into a linear chain, for the branching case where it ends a chain instead.
func trimComma(seg string) string { return strings.TrimSuffix(seg, ",") }

/*
cropCursor moves a recorded pointer track into a cropped picture's coordinates.

The sidecar's contract is that its samples are in the recorded video's own pixel
space. A crop makes that space smaller and moves its origin, and every consumer
of the track — the highlight, the click rings, the drawn cursor, the spotlight
mask — reads position as a fraction of Video.Width/Height. Shifting once, here,
is what keeps all of them right without any of them learning what a crop is.

Samples that fall outside the crop are dropped rather than clamped: the pointer
was genuinely not in the part of the picture that survived, and pinning it to
the nearest edge would draw a highlight sitting against the frame for as long as
the pointer was away.
*/
func cropCursor(t *cursor.Track, c *schema.Crop) *cursor.Track {
	if t == nil || c.Empty() || t.Video.Width <= 0 || t.Video.Height <= 0 {
		return t
	}
	x, y, w, h := c.Pixels(t.Video.Width, t.Video.Height)
	out := *t
	out.Video.Width, out.Video.Height = w, h
	out.Samples = make([]cursor.Sample, 0, len(t.Samples))
	for _, s := range t.Samples {
		sx, sy := s.X-x, s.Y-y
		if sx < 0 || sy < 0 || sx > w || sy > h {
			continue
		}
		s.X, s.Y = sx, sy
		out.Samples = append(out.Samples, s)
	}
	return &out
}

/*
prefitFilter fits a source of one shape into a canvas of another.

Three ways to do it, and the default is not one of them — it is a decision about
which of the other two, because a clip the camera is working (cursor effects or
zoom keyframes) must never letterbox. A push-in towards the edge of a letterboxed
picture would slide the transparent bar into frame, and what you see is the
recording appearing to come loose from its own background.

Returns a segment with a trailing comma, or "" when the shapes already agree and
the whole question is moot.
*/
func prefitFilter(fit string, srcW, srcH, w, h int, cameraClip bool) string {
	if srcW <= 0 || srcH <= 0 {
		return ""
	}
	if fit == schema.FitStretch {
		// Nothing to insert: the scale that follows already stretches to the
		// canvas box, which is exactly what stretch means.
		return ""
	}
	cover := fit == schema.FitCover || (fit == schema.FitAuto && cameraClip)
	srcA := float64(srcW) / float64(srcH)
	canA := float64(w) / float64(h)
	// The half-percent tolerance mirrors canvasForSource: capture pipelines
	// round dimensions, and refitting a rounding error would soften every frame
	// for nothing.
	if diff := srcA - canA; diff < 0.005*canA && diff > -0.005*canA {
		return ""
	}
	if cover {
		return fmt.Sprintf(
			"scale=%d:%d:force_original_aspect_ratio=increase:flags=bicubic,crop=%d:%d,format=rgba,",
			w, h, w, h)
	}
	return fmt.Sprintf(
		"scale=%d:%d:force_original_aspect_ratio=decrease:flags=bicubic,format=rgba,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black@0,",
		w, h, w, h)
}
