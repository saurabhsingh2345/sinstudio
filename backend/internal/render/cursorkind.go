package render

import (
	"fmt"
	"sort"
	"strings"

	"studio/internal/cursor"
)

// Turning a per-sample cursor kind into stretches of time.
//
// The renderer cannot swap an overlay's image partway through — an overlay's
// input is a stream, fixed when the graph is built. So each shape that occurs
// becomes its own overlay, enabled only over the stretches where it was showing.
// With one shape (an old cursord, a platform that cannot report shapes, or a
// take spent entirely on an arrow) that collapses to exactly the single overlay
// the renderer has always built.
//
// The cleanup below is not cosmetic. A pointer dragged across a row of links
// crosses in and out of the hand cursor several times a second, and a shape that
// honestly follows every one of those transitions strobes. Merging the gaps and
// dropping the flickers is what makes the feature usable rather than annoying.

const (
	// A shape held for less than this never appears. Crossing the corner of a
	// link on the way somewhere else is not a moment the viewer needs told
	// about.
	minKindSpan = 0.12
	// Two stretches of the same shape closer than this are one stretch. Moving
	// along a row of links briefly re-enters the arrow between them; honouring
	// that is a strobe.
	kindGapMerge = 0.2
	// A ceiling on the enable expression's size. Every span is a term in a
	// per-frame expression, and an unbounded one eventually fails to build at
	// all — the same reason click rings are capped.
	maxKindSpans = 150
)

// kindSpan is a stretch of SOURCE time over which one shape was showing.
type kindSpan struct {
	Kind       uint8
	Start, End float64
}

// cursorKindSpans divides a track into the stretches each shape was showing,
// clipped to the clip's visible range.
//
// Unknown (0) resolves to the arrow here rather than later, so everything
// downstream sees a shape it can draw and the "no kinds at all" case produces
// one arrow span covering everything.
func cursorKindSpans(samples []cursor.Sample, from, to float64) []kindSpan {
	if len(samples) == 0 || to <= from {
		return nil
	}
	resolve := func(k uint8) uint8 {
		if _, ok := cursorShapes[k]; ok {
			return k
		}
		return kindArrow
	}

	var raw []kindSpan
	cur := kindSpan{Kind: resolve(samples[0].K), Start: from, End: to}
	for _, s := range samples {
		t := float64(s.T) / 1000
		if t <= from {
			cur.Kind = resolve(s.K)
			continue
		}
		if t >= to {
			break
		}
		if k := resolve(s.K); k != cur.Kind {
			cur.End = t
			raw = append(raw, cur)
			cur = kindSpan{Kind: k, Start: t, End: to}
		}
	}
	cur.End = to
	raw = append(raw, cur)

	// Drop flickers into whatever preceded them, then merge neighbours that
	// ended up the same shape. Done in that order because dropping is what
	// creates most of the adjacent duplicates.
	var kept []kindSpan
	for _, s := range raw {
		if len(kept) > 0 && s.End-s.Start < minKindSpan {
			kept[len(kept)-1].End = s.End
			continue
		}
		kept = append(kept, s)
	}
	var out []kindSpan
	for _, s := range kept {
		if n := len(out); n > 0 && out[n-1].Kind == s.Kind && s.Start-out[n-1].End < kindGapMerge {
			out[n-1].End = s.End
			continue
		}
		out = append(out, s)
	}
	return out
}

// kindsPresent lists the shapes a span set uses, in a stable order so the
// overlays are built the same way every render.
func kindsPresent(spans []kindSpan) []uint8 {
	seen := map[uint8]bool{}
	var out []uint8
	for _, s := range spans {
		if !seen[s.Kind] {
			seen[s.Kind] = true
			out = append(out, s.Kind)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// enableFor builds the timeline-time enable expression for one shape.
//
// The terms are summed rather than or-ed because ffmpeg's enable treats any
// non-zero value as on, and between() returns 1 or 0 — so a sum is an OR that
// needs no operator the expression parser might treat differently.
func enableFor(spans []kindSpan, kind uint8, toTimeline func(float64) float64) string {
	var terms []string
	for _, s := range spans {
		if s.Kind != kind {
			continue
		}
		if len(terms) >= maxKindSpans {
			break
		}
		terms = append(terms, fmt.Sprintf("between(t,%.3f,%.3f)", toTimeline(s.Start), toTimeline(s.End)))
	}
	if len(terms) == 0 {
		return "0"
	}
	return strings.Join(terms, "+")
}

// samplesIn keeps only the samples inside one shape's stretches.
//
// The overlay is disabled outside them, so commanding its position there would
// be work with no effect — and with six shapes that is six times the command
// script for one cursor. The sample that opens each stretch is inside it by
// construction, so every overlay is positioned correctly the moment it appears.
func samplesIn(samples []cursor.Sample, spans []kindSpan, kind uint8) []cursor.Sample {
	out := make([]cursor.Sample, 0, len(samples))
	for _, s := range samples {
		t := float64(s.T) / 1000
		for _, sp := range spans {
			if sp.Kind != kind {
				continue
			}
			if t >= sp.Start && t <= sp.End {
				out = append(out, s)
				break
			}
		}
	}
	return out
}
