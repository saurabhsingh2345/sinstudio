package render

import (
	"math"
	"sort"

	"studio/internal/schema"
)

/*
Crossfades — what a clip's transition is actually a transition *to*.

A transition is written on ONE clip ("this clip fades in"), which says enough
only when there is nothing underneath it. At the head of the timeline a fade-in
rises out of the canvas background, and that is exactly what a fade there should
be. At a cut between two scenes it is not: clips laid on the video lane are
BUTT-JOINED, so the instant the second one starts the first no longer exists,
and its fade-in dissolved up from the canvas background colour. Every transition
the editor could apply was a flash of flat colour punched between two scenes,
never one scene becoming the next.

So a transition at a JOINT is resolved against the neighbour instead:

  - the incoming clip's transition plays over the outgoing one, which stays
    opaque underneath for exactly the transition's length — its own frames where
    the two clips overlap, else its last frame held (tpad=clone, the same freeze
    Hold renders);
  - the outgoing clip's fade/dissolve OUT is dropped at that joint. It is
    overlaid UNDER the clip that follows, so fading it out cannot reveal that
    clip — it can only punch a hole through to the background, which is the same
    bug wearing the other side's clothes;
  - a fade/dissolve out whose successor carries no transition of its own becomes
    that successor's dissolve IN. "Transition out of A" and "transition into B"
    at one joint are one cross-dissolve, whichever side it was written on.

FadeIn/FadeOut are deliberately left alone. Those are the fade to and from the
background — the punctuation between two scenes — and a document that asks for
one still gets one. A clip with a FadeOut therefore keeps its hole to the
background and is not held over the cut.

Only the scene lanes take part. A video or background clip is a full-canvas
picture with nothing but the canvas behind it. An overlay clip fades out to
TRANSPARENT and reveals the video below, which was already right, and holding
one over its successor would park a stale badge on top of the next scene.

Mirrors frontend/src/crossfade.ts — same joints, same numbers, asserted from
both sides.
*/

// jointEps is how close two clips must be to count as joined, in seconds. One
// frame at 60fps: a cut authored by dragging can land a hair off the
// neighbour's end, and a gap that small is not one anybody asked to see the
// background through.
const jointEps = 1.0 / 60.0

// crossJoint is the rule's answer for one clip: its resolved transitions, plus
// how long its picture outlives it to carry the next clip's transition.
type crossJoint struct {
	cover    float64
	transIn  *schema.Transition
	transOut *schema.Transition
}

// crossfades maps clip id to the joints it takes part in. Clips no joint
// touches are absent, so a document without transitions plans nothing.
type crossfades map[string]crossJoint

// resolve returns the clip with its transitions read against its neighbours,
// and the seconds of frozen tail its picture must hold past its own end.
func (x crossfades) resolve(c schema.Clip) (schema.Clip, float64) {
	j, ok := x[c.ID]
	if !ok {
		return c, 0
	}
	c.TransitionIn, c.TransitionOut = j.transIn, j.transOut
	return c, j.cover
}

// isDissolve reports whether a transition is one that fades the clip's alpha —
// the only kind that can show the background through a joint.
func isDissolve(t *schema.Transition) bool {
	return t != nil && (t.Type == "fade" || t.Type == "dissolve")
}

func crossDur(t *schema.Transition) float64 {
	if t.Duration > 0 {
		return t.Duration
	}
	return defTransDur
}

// planCrossfades resolves every joint on every scene lane of the document.
func planCrossfades(tracks []schema.Track) crossfades {
	plan := crossfades{}
	for _, t := range tracks {
		if t.Hidden || (t.Kind != schema.TrackVideo && t.Kind != schema.TrackBackground) {
			continue
		}
		// Overlay order is array order (see byZ + the visuals loop), and it
		// decides which clip of a pair can cover the other, so it rides along
		// with the sort by time.
		type laneClip struct {
			c     schema.Clip
			order int
		}
		var lane []laneClip
		for i, c := range t.Clips {
			if !c.Disabled {
				lane = append(lane, laneClip{c: c, order: i})
			}
		}
		sort.SliceStable(lane, func(i, j int) bool {
			if lane[i].c.Start != lane[j].c.Start {
				return lane[i].c.Start < lane[j].c.Start
			}
			return lane[i].order < lane[j].order
		})

		for i := 0; i+1 < len(lane); i++ {
			a, b := lane[i], lane[i+1]
			aEnd := a.c.Start + a.c.PlayDur()
			// A real gap: the background belongs there, and so does a fade into it.
			if b.c.Start > aEnd+jointEps {
				continue
			}
			// B has to be overlaid on top of A for any of this to read as a
			// transition. It normally is — later clip, later in the lane — but Z
			// or array order can say otherwise, and holding A over B would blank
			// the incoming scene for the transition's length instead of
			// revealing it.
			if b.c.Z < a.c.Z || (b.c.Z == a.c.Z && b.order < a.order) {
				continue
			}

			// The one transition at this joint, whichever clip carries it.
			tIn := b.c.TransitionIn
			if tIn == nil && isDissolve(a.c.TransitionOut) {
				tIn = &schema.Transition{Type: "dissolve", Duration: crossDur(a.c.TransitionOut)}
			}
			if tIn == nil {
				continue
			}
			d := crossDur(tIn)

			// Only the part of the transition the overlap does not already
			// cover, and never past the successor's own end — the tail is a
			// courtesy to B, not a second life for A.
			cover := math.Min(math.Max(0, d-(aEnd-b.c.Start)), b.c.PlayDur())
			// A clip asked to fade to the background is already gone by its end;
			// holding an invisible frame over the cut would decode for nothing.
			if a.c.FadeOut > 0 {
				cover = 0
			}

			ja := plan.entry(a.c)
			ja.cover = math.Max(ja.cover, cover)
			if isDissolve(a.c.TransitionOut) {
				ja.transOut = nil
			}
			plan[a.c.ID] = ja

			jb := plan.entry(b.c)
			jb.transIn = tIn
			plan[b.c.ID] = jb
		}
	}
	return plan
}

// entry is the clip's own transitions, ready for the joint rule to overwrite.
func (x crossfades) entry(c schema.Clip) crossJoint {
	if j, ok := x[c.ID]; ok {
		return j
	}
	return crossJoint{transIn: c.TransitionIn, transOut: c.TransitionOut}
}
