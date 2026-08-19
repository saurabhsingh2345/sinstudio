// crossfade — what a clip's transition is actually a transition *to*.
//
// A transition is written on ONE clip ("this clip fades in"), which says enough
// only when there is nothing underneath it. At the head of the timeline a
// fade-in rises out of the canvas background, and that is exactly what a fade
// there should be. At a cut between two scenes it is not, and that is the bug
// this file exists to fix: clips dropped on the video lane are BUTT-JOINED, so
// the instant the second one starts the first no longer exists — and a fade-in
// there dissolved up from the canvas background colour. Every transition the
// Inspector can apply was therefore a flash of flat colour punched between two
// scenes (blue, with the templates the wizard shipped), never one scene
// becoming the next.
//
// So a transition at a JOINT is resolved against the neighbour instead:
//
//   - the incoming clip's transition plays over the outgoing one, which stays
//     opaque underneath for exactly the transition's length — its own frames
//     where the two clips overlap, else its last frame held, which is the
//     freeze `hold` already renders (tpad=clone in the exporter);
//   - the outgoing clip's fade/dissolve OUT is dropped at that joint. It is
//     painted UNDER the clip that follows, so fading it out cannot reveal that
//     clip — it can only punch a hole through to the background, which is the
//     bug again, wearing the other side's clothes;
//   - a fade/dissolve out whose successor has no transition of its own becomes
//     that successor's dissolve IN. "Transition out of A" and "transition into
//     B" at one joint are one cross-dissolve, whichever side it was written on.
//
// `fadeIn`/`fadeOut` are deliberately left alone. Those are the fade to and
// from the background — the punctuation between two scenes — and a document
// that asks for one still gets one. A clip with a fadeOut therefore keeps its
// hole to the background and is not held over the cut.
//
// Only the scene lanes take part. A video or background clip is a full-canvas
// picture with nothing but the canvas behind it. An overlay clip fades out to
// TRANSPARENT and reveals the video below, which was already right, and holding
// one over its successor would park a stale badge on top of the next scene.
//
// Keep in sync with backend/internal/render/crossfade.go — the two are asserted
// against the same joints from both sides.

import { clipPlayDur, type Clip, type Track, type Transition } from "./types";

/** Fallback transition length when a document leaves it unset. Mirrors DEF_TRANS. */
export const DEF_CROSS_DUR = 0.5;

/** Lanes whose clips are scenes over the canvas rather than decoration over a scene. */
const SCENE_KINDS = new Set(["video", "background"]);

/**
 * How close two clips must be to count as joined, in seconds. A frame at 60fps:
 * a cut authored by dragging can land a hair off the neighbour's end, and a gap
 * that small is not a gap anybody asked to see the background through.
 */
export const JOINT_EPS = 1 / 60;

/** A clip's transitions after the joint rule, plus how long it outlives itself. */
export interface ClipCross {
  /**
   * Extra seconds this clip's picture stays on screen past its own end, frozen
   * on its last frame, so the next clip's transition has a scene to land on.
   * Never extends the project: the tail is always inside the successor's span.
   */
  cover: number;
  transitionIn?: Transition;
  transitionOut?: Transition;
}

const isDissolve = (t?: Transition): boolean => !!t && (t.type === "fade" || t.type === "dissolve");

const transDur = (t: Transition): number => (t.duration > 0 ? t.duration : DEF_CROSS_DUR);

/**
 * planCrossfades resolves every joint on every scene lane, keyed by clip id.
 * Clips no joint touches are absent from the map, so a document with no
 * transitions costs one pass and allocates nothing.
 */
export function planCrossfades(tracks: Track[]): Map<string, ClipCross> {
  const plan = new Map<string, ClipCross>();
  for (const track of tracks) {
    if (track.hidden || !SCENE_KINDS.has(track.kind)) continue;
    // Paint order is array order (see activeVisuals), and it decides which clip
    // of a pair can cover the other, so it is carried alongside the sort by time.
    const lane = (track.clips || [])
      .map((clip, order) => ({ clip, order }))
      .filter(({ clip }) => !clip.disabled)
      .sort((a, b) => a.clip.start - b.clip.start || a.order - b.order);

    for (let i = 0; i < lane.length - 1; i++) {
      const a = lane[i];
      const b = lane[i + 1];
      const aEnd = a.clip.start + clipPlayDur(a.clip);
      // A real gap: the background belongs there, and so does a fade into it.
      if (b.clip.start > aEnd + JOINT_EPS) continue;
      // B has to be painted over A for any of this to read as a transition. It
      // normally is — later clip, later in the lane — but z or array order can
      // say otherwise, and holding A on top of B would blank the incoming scene
      // for the length of the transition instead of revealing it.
      const az = a.clip.z ?? 0;
      const bz = b.clip.z ?? 0;
      if (bz < az || (bz === az && b.order < a.order)) continue;

      // The one transition at this joint, whichever clip it was written on.
      let tIn = b.clip.transitionIn;
      if (!tIn && isDissolve(a.clip.transitionOut)) {
        tIn = { type: "dissolve", duration: transDur(a.clip.transitionOut!) };
      }
      if (!tIn) continue;
      const d = transDur(tIn);

      // Only the part of the transition the overlap does not already cover, and
      // never past the successor's own end — the tail is a courtesy to B, not a
      // second life for A.
      let cover = Math.min(Math.max(0, d - (aEnd - b.clip.start)), clipPlayDur(b.clip));
      // A clip asked to fade to the background is already gone by its end;
      // holding an invisible frame over the cut would decode for nothing.
      if (a.clip.fadeOut && a.clip.fadeOut > 0) cover = 0;

      const ax = entry(plan, a.clip);
      ax.cover = Math.max(ax.cover, cover);
      if (isDissolve(a.clip.transitionOut)) ax.transitionOut = undefined;

      entry(plan, b.clip).transitionIn = tIn;
    }
  }
  return plan;
}

/** The clip's own transitions, ready to be overwritten by the joint rule. */
function entry(plan: Map<string, ClipCross>, clip: Clip): ClipCross {
  let e = plan.get(clip.id);
  if (!e) {
    e = { cover: 0, transitionIn: clip.transitionIn, transitionOut: clip.transitionOut };
    plan.set(clip.id, e);
  }
  return e;
}

/**
 * crossClip applies a plan entry to a clip: the same object when no joint
 * touched it, else a copy whose transitions are the resolved ones. Everything
 * downstream then reads transitions without knowing joints exist.
 */
export function crossClip(clip: Clip, plan: Map<string, ClipCross> | undefined): Clip {
  const x = plan?.get(clip.id);
  if (!x) return clip;
  const next = { ...clip };
  if (x.transitionIn) next.transitionIn = x.transitionIn;
  else delete next.transitionIn;
  if (x.transitionOut) next.transitionOut = x.transitionOut;
  else delete next.transitionOut;
  return next;
}

/** Seconds the clip's frozen last frame covers the next clip's transition. */
export function clipCover(clip: Clip, plan: Map<string, ClipCross> | undefined): number {
  return plan?.get(clip.id)?.cover ?? 0;
}
