import { kfValue } from "./components/studio/preview-engine";
import { safeEase } from "./ease";
import type { Keyframe } from "./types";

// Zoom-n-pan: the manual half of what SmartFocus does automatically.
//
// A zoom is described the way an editor thinks about it — "make THIS rectangle
// fill the frame, from here to here" — and compiled down to the scale/x/y
// keyframes the engine already understands. Nothing new reaches the renderer,
// so a hand-placed zoom and an auto-detected one are the same object by the
// time they are drawn, and both stay draggable on the timeline afterwards.
//
// The rectangle is the source of truth for the UI; the keyframes are the source
// of truth for the document. `readZoomStops` recovers the former from the
// latter, so dragging a diamond on the timeline is reflected back in the panel
// rather than being silently overwritten by a stale rectangle.

/** A region of the canvas, in canvas pixels, to be blown up to fill the frame. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Beyond this a screen recording is showing individual pixels, not detail. */
export const MAX_ZOOM = 8;

// Matches SMART_FOCUS_DEFAULTS.ramp, so a hand-placed zoom moves like a found
// one — they share the emitter and should share the feel.
export const DEFAULT_RAMP = 0.9;
// Spring by default, matching SmartFocus — a hand-placed zoom and a found one
// should feel identical, which is the whole reason they share this emitter.
export const DEFAULT_EASE = "springOut";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Offset that brings a point to the centre of frame at a given scale.
 *
 * Derivation: the clip is drawn at width W*s centred on the canvas, so a source
 * point px sits at (W-W*s)/2 + offX + px*s. Setting that equal to W/2 gives
 * offX = s*(W/2 - px).
 *
 * The clamp is what keeps background from showing: at scale s the frame
 * overhangs the canvas by W*(s-1)/2 per side, and panning further than that
 * pulls its edge inside the frame. At s = 1 the bound is zero, so a full-size
 * clip correctly refuses to pan at all.
 */
export function centerOffset(point: number, size: number, scale: number): number {
  const bound = (size * (scale - 1)) / 2;
  const v = clamp(scale * (size / 2 - point), -bound, bound);
  // Clamping against a zero bound yields -0, which is numerically fine but
  // serializes into the document as "-0". Normalize so saved keyframes read
  // cleanly.
  return v === 0 ? 0 : v;
}

/**
 * Force a rectangle to be something the engine can actually express: the canvas
 * aspect (one `scale` drives both axes, so a differently-shaped rectangle is
 * not representable) and wholly inside the canvas.
 *
 * Containment is not cosmetic — it is the same rule `centerOffset` clamps to.
 * A rectangle hanging over the edge would ask to pan further than the zoom
 * allows, and the frame's edge would come into view as visible background.
 */
export function clampRect(rect: Rect, canvas: Size): Rect {
  const aspect = canvas.width / canvas.height;
  const w = clamp(rect.w, canvas.width / MAX_ZOOM, canvas.width);
  const h = w / aspect;
  return {
    x: clamp(rect.x, 0, canvas.width - w),
    y: clamp(rect.y, 0, canvas.height - h),
    w,
    h,
  };
}

/** The rectangle that fills the frame at scale 1 — i.e. no zoom at all. */
export const fullFrame = (canvas: Size): Rect => ({ x: 0, y: 0, w: canvas.width, h: canvas.height });

/** Rectangle → the transform that makes it fill the frame. */
export function rectToTransform(rect: Rect, canvas: Size): { scale: number; x: number; y: number } {
  const r = clampRect(rect, canvas);
  const scale = clamp(canvas.width / r.w, 1, MAX_ZOOM);
  return {
    scale,
    x: centerOffset(r.x + r.w / 2, canvas.width, scale),
    y: centerOffset(r.y + r.h / 2, canvas.height, scale),
  };
}

/** The inverse, so an existing keyframe can be shown as a draggable rectangle. */
export function transformToRect(scale: number, x: number, y: number, canvas: Size): Rect {
  const s = clamp(scale, 1, MAX_ZOOM);
  const w = canvas.width / s;
  const h = canvas.height / s;
  // Inverting offX = s*(W/2 - px) gives px = W/2 - offX/s.
  return {
    x: canvas.width / 2 - x / s - w / 2,
    y: canvas.height / 2 - y / s - h / 2,
    w,
    h,
  };
}

/** Convenience for the UI's zoom slider, which thinks in multiples, not widths. */
export const rectForZoom = (zoom: number, centre: { x: number; y: number }, canvas: Size): Rect => {
  const s = clamp(zoom, 1, MAX_ZOOM);
  const w = canvas.width / s;
  const h = canvas.height / s;
  return clampRect({ x: centre.x - w / 2, y: centre.y - h / 2, w, h }, canvas);
};

/** A zoom the editor placed: hold this region from `start` to `end`. */
export interface ZoomStop {
  start: number;
  end: number;
  rect: Rect;
  /** Seconds to travel into this zoom from whatever preceded it. */
  ramp: number;
  ease: string;
}

/** A stop with its rectangle already resolved to engine values. */
export interface ZoomHold {
  start: number;
  end: number;
  scale: number;
  x: number;
  y: number;
  ramp: number;
  ease: string;
  /**
   * Positions to drift through during the hold, so the frame can follow the
   * pointer instead of locking to one spot. Already clamped by the caller.
   */
  path?: { t: number; x: number; y: number }[];
}

export const holdFromStop = (stop: ZoomStop, canvas: Size): ZoomHold => ({
  start: stop.start,
  end: stop.end,
  ramp: stop.ramp,
  ease: stop.ease,
  ...rectToTransform(stop.rect, canvas),
});

/**
 * Compile held zooms into scale/x/y keyframes.
 *
 * Shared with SmartFocus, which differs only in where its holds come from —
 * so an auto zoom and a hand-placed one produce identically-shaped motion, and
 * there is one copy of the rules about when to pull back and when to pan.
 */
export function zoomKeyframes(holds: ZoomHold[], duration: number): Record<string, Keyframe[]> {
  if (!holds.length) return {};

  const scale: Keyframe[] = [];
  const xs: Keyframe[] = [];
  const ys: Keyframe[] = [];

  // Keys must ascend strictly; a later write at the same instant replaces the
  // earlier one rather than producing a zero-length segment.
  const at = (t: number, s: number, ox: number, oy: number, ease: string) => {
    const tt = +Math.max(0, Math.min(duration, t)).toFixed(3);
    const push = (arr: Keyframe[], value: number) => {
      const prev = arr[arr.length - 1];
      if (prev && prev.t >= tt) {
        prev.t = tt;
        prev.value = value;
        prev.ease = ease;
        return;
      }
      arr.push({ t: tt, value, ease });
    };
    push(scale, +s.toFixed(4));
    push(xs, Math.round(ox));
    push(ys, Math.round(oy));
  };

  const ordered = [...holds].sort((a, b) => a.start - b.start);

  /*
   * A hold must have room for its ramps.
   *
   * Without this the ramp is whatever time happens to be left: `at` clamps
   * every keyframe into [0, duration], so a zoom ending near the clip's end
   * gets its pull-out compressed into the remainder. On a real 3.7s recording
   * that produced a 0.165s pull-out against a requested 0.9s — a snap, and with
   * a spring on the way in, a snap that bounces. Long recordings never showed
   * it, which is why it survived.
   *
   * The hold moves rather than the ramp shrinking. Losing part of a hold costs
   * a moment of dwell on something already on screen; losing the ramp costs the
   * move itself, which is the thing being watched. A hold with nowhere left to
   * go is dropped: no zoom at all is better than one that snaps.
   */
  const sorted = ordered
    .map((h) => {
      // On a clip too short for two full ramps, the ramp itself has to give —
      // there is no arrangement that fits otherwise.
      const ramp = Math.min(h.ramp, duration / 2);
      const start = clamp(h.start, ramp, duration - ramp);
      const end = clamp(h.end, start, duration - ramp);
      return { ...h, start, end, ramp };
    })
    .filter((h) => h.end > h.start);

  if (!sorted.length) return {};

  /*
   * Overshoot belongs on the push-in and NOWHERE else.
   *
   * Arriving at a subject with a little lean past it and a settle is what makes
   * an auto-zoom feel authored rather than mechanical. Every other segment ends
   * on a hard limit, and going past a hard limit shows background:
   *
   *   - pulling out ends at scale 1. Overshooting means scale < 1, so the clip
   *     is smaller than the canvas and the backdrop shows around it.
   *   - a pan's endpoints are clamped to exactly what the current scale can
   *     cover (centerOffset), so anything beyond them runs off the footage.
   *
   * Hence safeEase on the way out and across, and h.ease only on the way in.
   */
  const out = (h: ZoomHold) => safeEase(h.ease);

  // Start wide, so the first zoom has something to move from.
  at(0, 1, 0, 0, out(sorted[0]));

  sorted.forEach((h, i) => {
    const prev = sorted[i - 1];

    if (!prev) {
      const inStart = Math.max(0, h.start - h.ramp);
      if (inStart > 0) at(inStart, 1, 0, 0, h.ease); // push in
    } else if (h.start - prev.end >= prev.ramp + h.ramp) {
      // Room to breathe: pull back to full frame between the two.
      at(prev.end + prev.ramp, 1, 0, 0, out(h));
      at(Math.max(prev.end + prev.ramp, h.start - h.ramp), 1, 0, 0, h.ease); // push in
    }
    // Otherwise stay zoomed and let x/y carry the move — a pan straight from
    // one target to the next. Pulling out and back in over a gap this short
    // reads as a flinch, and both endpoints are clamped at the same scale, so
    // interpolating between them can never expose background either — provided
    // the interpolation stays BETWEEN them, which is why this ease is safe.
    // A hold either sits still or drifts along its path. The drift is eased,
    // never sprung: every point is clamped to what the scale can cover, and
    // overshooting a clamped point is what shows background.
    const path = (h.path ?? []).filter((p) => p.t > h.start && p.t < h.end);
    at(h.start, h.scale, h.x, h.y, path.length ? "easeInOut" : "linear");
    for (const p of path) at(p.t, h.scale, p.x, p.y, "easeInOut");
    // The hold ends wherever the drift left it; going back to the anchor would
    // undo the following in one snap right before pulling out.
    const last = path[path.length - 1];
    at(h.end, h.scale, last?.x ?? h.x, last?.y ?? h.y, out(h));
  });

  const last = sorted[sorted.length - 1];
  at(Math.min(duration, last.end + last.ramp), 1, 0, 0, out(last));
  if (scale[scale.length - 1].t < duration) at(duration, 1, 0, 0, "linear");

  return { scale, x: xs, y: ys };
}

/** Write stops into a clip's keyframes, leaving properties zoom doesn't drive alone. */
export function applyZoomStops(
  existing: Record<string, Keyframe[]> | undefined,
  stops: ZoomStop[],
  duration: number,
  canvas: Size
): Record<string, Keyframe[]> | undefined {
  const rest = { ...(existing ?? {}) };
  delete rest.scale;
  delete rest.x;
  delete rest.y;
  if (!stops.length) return Object.keys(rest).length ? rest : undefined;
  return { ...rest, ...zoomKeyframes(stops.map((s) => holdFromStop(s, canvas)), duration) };
}

const EPS = 1e-3;

// kfValue assumes at least one key. A clip legitimately carries scale and x but
// no y (a zoom that only ever panned sideways), and an unkeyed property is not
// animated — which for an offset means zero.
const sample = (keys: Keyframe[], t: number) => (keys.length ? kfValue(keys, t) : 0);

/**
 * Recover the editable stops from a clip's keyframes.
 *
 * A stop is a *held* region: two consecutive scale keys with the same value and
 * the same offsets. Anything else — a ramp, or a pan between two stops — is
 * motion between stops, not a stop, and deliberately isn't listed as one.
 *
 * x/y are sampled with `kfValue` rather than read by index, so keyframes that
 * were hand-edited on the timeline (and no longer line up key-for-key with
 * scale) still read back as something sensible instead of being dropped.
 */
export function readZoomStops(
  keyframes: Record<string, Keyframe[]> | undefined,
  canvas: Size
): ZoomStop[] {
  const scale = keyframes?.scale ?? [];
  if (scale.length < 2) return [];
  const xs = keyframes?.x ?? [];
  const ys = keyframes?.y ?? [];

  const out: ZoomStop[] = [];
  for (let i = 0; i < scale.length - 1; i++) {
    const a = scale[i];
    const b = scale[i + 1];
    if (a.value <= 1 + EPS) continue;
    if (Math.abs(a.value - b.value) > EPS) continue;

    const ax = sample(xs, a.t);
    const ay = sample(ys, a.t);
    // Same scale but a moving offset is a pan, not a hold.
    if (Math.abs(ax - sample(xs, b.t)) > 0.5) continue;
    if (Math.abs(ay - sample(ys, b.t)) > 0.5) continue;

    const prev = scale[i - 1];
    out.push({
      start: a.t,
      end: b.t,
      rect: clampRect(transformToRect(a.value, ax, ay, canvas), canvas),
      ramp: prev ? Math.max(0, +(a.t - prev.t).toFixed(3)) : DEFAULT_RAMP,
      // A keyframe's ease governs the segment LEAVING it, so the ramp into this
      // hold is eased by the key before it.
      ease: prev?.ease || DEFAULT_EASE,
    });
    i++; // the pair is consumed; b cannot also open a stop
  }
  return out;
}

/**
 * Place or replace a stop, keeping the list ordered and non-overlapping.
 *
 * Overlaps are resolved by dropping what the new stop covers rather than by
 * shortening it: two zooms held at once is not a state the engine can render,
 * and a silently-truncated zoom is harder to understand than a replaced one.
 */
export function upsertStop(stops: ZoomStop[], next: ZoomStop): ZoomStop[] {
  const kept = stops.filter((s) => s.end <= next.start || s.start >= next.end);
  return [...kept, next].sort((a, b) => a.start - b.start);
}
