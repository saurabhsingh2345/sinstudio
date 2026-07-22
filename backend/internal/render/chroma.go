package render

import (
	"fmt"
	"strings"

	"studio/internal/schema"
)

/*
Chroma key — knocking a green screen out of a clip so what is behind it shows
through.

This is the one effect whose whole purpose is to change a clip's ALPHA, and the
chain it lives in is built around that not happening: every other per-clip
filter adjusts colour and leaves opacity to the transform. So it runs first, on
the source's own pixels, before scaling. Keying after a scale means keying
pixels that have already been blended with their neighbours — every edge of the
subject picks up a halo of interpolated green that no similarity threshold can
separate from the real thing, because by then it genuinely is a mix of both.

`chromakey` rather than `colorkey`: it measures distance in the U/V plane, so it
largely discounts brightness. A green screen is never evenly lit — it falls off
at the edges and hot-spots under the lamps — and an RGB distance treats the dim
corner and the bright centre as far apart, forcing the threshold so wide that it
starts eating the subject. Chroma distance pulls them close enough for one
threshold to cover the screen.

Close, not identical: U and V still scale with intensity, so a badly lit screen
still needs a wider Amount than a well lit one. The preview shader has the same
property on purpose, so tuning against it transfers to the export.
*/

// defChromaColor is the standard chroma green (Rosco 4600 / "Chroma Green"),
// not pure #00FF00 — real screens are painted this, and starting from the
// colour the fabric actually is means the first preview is usually close.
const defChromaColor = "#00b140"

const (
	defChromaSimilarity = 0.25
	defChromaBlend      = 0.05
)

/*
despillType picks which cast to neutralise from the key colour itself.

Spill is the screen's light bouncing onto the subject, so it is always the
screen's own hue — deriving it from the key rather than asking means one less
control that can be set to contradict the colour right above it.
*/
func despillType(hex string) string {
	c := hexColor(hex, defChromaColor)
	if c.B > c.G {
		return "blue"
	}
	return "green"
}

/*
chromaFilters builds the key for one clip, or "" when there is nothing to do.

Returned with a leading comma so it can be appended to a chain unconditionally,
matching effectFilters().
*/
func chromaFilters(c *schema.ChromaKey) string {
	if c == nil {
		return ""
	}
	color := strings.TrimSpace(c.Color)
	if color == "" {
		color = defChromaColor
	}
	sim := c.Similarity
	if sim <= 0 {
		sim = defChromaSimilarity
	}
	blend := c.Blend
	if blend < 0 {
		blend = defChromaBlend
	}

	var b strings.Builder
	// yuva420p first: chromakey needs somewhere to write alpha, and a source
	// decoded as yuv420p has no alpha plane to write into — without this the key
	// computes correctly and is then discarded, which looks like the filter
	// silently doing nothing.
	fmt.Fprintf(&b, ",format=yuva420p,chromakey=%s:%.4f:%.4f", ffColor(color), sim, blend)

	// Despill AFTER the key. It only has to fix what survived; running it first
	// would neutralise the very cast the key measures distance against, pulling
	// the subject's edges toward the threshold.
	if c.Spill > 0 {
		fmt.Fprintf(&b, ",despill=type=%s:mix=%.4f", despillType(color), clampF(c.Spill, 0, 1))
	}
	return b.String()
}
