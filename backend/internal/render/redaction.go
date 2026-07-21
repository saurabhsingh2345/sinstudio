package render

import (
	"fmt"
	"strings"

	"studio/internal/schema"
)

// Region blur / pixelate — hiding a password, a name or a licence key that
// shouldn't ship.
//
// Unlike an annotation this is not something drawn over the frame: it resamples
// the frame's own pixels, so there is nothing to peel off the finished video.
// The shape of it in ffmpeg is always the same three steps — split the stream,
// mangle a cropped copy of the region, lay it back where it came from.
//
// Every dimension is an *expression* over `iw`/`ih` rather than a number, which
// is what makes this work without knowing the source resolution at compile
// time, and keeps a 4K capture and a 720p one equally redacted.

// redactionStrength turns the 0..1 amount into a resampling factor. The region
// is scaled down by this and back up, so the factor is relative to the region's
// own size — a fixed blur radius would be strong on a small clip and useless on
// a large one.
func redactionStrength(amount float64) float64 {
	if amount <= 0 {
		amount = 0.6 // 0 means unset, matching the rest of the schema
	}
	return 4 + clampF(amount, 0, 1)*28 // 4×..32×
}

/*
redactFilter is the chain applied to the cropped region.

Both kinds are a downsample followed by an upsample; only the interpolation
differs, which is exactly the difference between a mosaic and a blur. Rounding
the downsample UP means the restored patch is never smaller than the region it
has to cover — a patch a pixel short would leave a sliver of the secret visible
along an edge, and over-covering is the safe direction to err.
*/
func redactFilter(kind string, amount float64) string {
	n := redactionStrength(amount)
	down := fmt.Sprintf("scale=w='max(1,ceil(iw/%.3f))':h='max(1,ceil(ih/%.3f))'", n, n)
	up := fmt.Sprintf("scale=w='iw*%.3f':h='ih*%.3f'", n, n)

	if kind == schema.RedactPixelate {
		// Nearest neighbour both ways keeps the blocks hard-edged.
		return fmt.Sprintf(",%s:flags=neighbor,%s:flags=neighbor", down, up)
	}
	// Blur: smooth interpolation, plus a small gaussian on the *downsampled*
	// image to kill the residual blockiness. Sigma is applied at the reduced
	// size, so it stays resolution-independent like everything else here.
	return fmt.Sprintf(",%s:flags=bilinear,gblur=sigma=2,%s:flags=bilinear", down, up)
}

/*
writeRedaction emits one region's split/crop/resample/overlay and returns the
label carrying the result, so regions chain: each one redacts the output of the
last, and a clip may hide several things at once.
*/
func writeRedaction(fc *strings.Builder, in string, vi, ri int, r schema.Redaction) string {
	bg := fmt.Sprintf("[rb%d_%d]", vi, ri)
	fg := fmt.Sprintf("[rf%d_%d]", vi, ri)
	patch := fmt.Sprintf("[rp%d_%d]", vi, ri)
	out := fmt.Sprintf("[ro%d_%d]", vi, ri)

	fmt.Fprintf(fc, "%ssplit=2%s%s;", in, bg, fg)
	// crop's w/h/x/y take expressions, so the region is resolution-independent.
	// The 2px floor keeps a degenerate region from producing a zero-sized crop,
	// which ffmpeg rejects outright and would fail the whole export.
	fmt.Fprintf(fc, "%scrop=w='max(2,iw*%.6f)':h='max(2,ih*%.6f)':x='iw*%.6f':y='ih*%.6f'%s%s;",
		fg, r.W, r.H, r.X, r.Y, redactFilter(r.Kind, r.Amount), patch)
	// overlay's W/H are the *main* frame's, so the same fractions place the patch
	// back exactly where it was cropped from.
	fmt.Fprintf(fc, "%s%soverlay=x='W*%.6f':y='H*%.6f'%s;", bg, patch, r.X, r.Y, out)
	return out
}

// validRedactions drops regions that would produce an invalid filtergraph. A
// zero-sized or fully off-frame region cannot hide anything, and letting one
// through fails the entire export rather than just itself.
func validRedactions(rs []schema.Redaction) []schema.Redaction {
	out := make([]schema.Redaction, 0, len(rs))
	for _, r := range rs {
		if r.W <= 0 || r.H <= 0 || r.X >= 1 || r.Y >= 1 || r.X+r.W <= 0 || r.Y+r.H <= 0 {
			continue
		}
		// Clamp into frame; a region hanging off the edge crops out of bounds.
		if r.X < 0 {
			r.W += r.X
			r.X = 0
		}
		if r.Y < 0 {
			r.H += r.Y
			r.Y = 0
		}
		if r.X+r.W > 1 {
			r.W = 1 - r.X
		}
		if r.Y+r.H > 1 {
			r.H = 1 - r.Y
		}
		if r.W <= 0 || r.H <= 0 {
			continue
		}
		out = append(out, r)
	}
	return out
}
