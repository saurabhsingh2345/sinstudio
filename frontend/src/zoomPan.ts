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
  return centerOffsetIn(point, size, scale, 0, size);
}

/**
 * centerOffset, aware that the picture may not fill its own box.
 *
 * A recording whose shape differs from the canvas is letterboxed into it —
 * the content occupies [c0, c1] of the box on this axis and the bars fill the
 * rest. Panning to the plain canvas bound then frames a bar: the math kept the
 * BOX on screen while the black crept in from its edge, magnified by the zoom.
 * That is exactly the "camera runs to the side of the page and the frame goes
 * black" failure.
 *
 * Derivation: the box edge sits at (size-size*s)/2 + off, so the content edges
 * sit s*c0 and s*c1 past it. Keeping the viewport [0, size] inside the content
 * needs off ≤ size*(s-1)/2 - s*c0 and off ≥ size*(1+s)/2 - s*c1. With content
 * filling the box (c0=0, c1=size) both collapse to the familiar ±size*(s-1)/2.
 *
 * When the scale is too small to fill the viewport with content at all, the
 * bounds cross; the honest answer is the middle — bars show symmetrically,
 * which is the letterbox the clip already had at full frame, not a new fault.
 */
export function centerOffsetIn(point: number, size: number, scale: number, c0: number, c1: number): number {
  const hi = (size * (scale - 1)) / 2 - scale * c0;
  const lo = (size * (1 + scale)) / 2 - scale * c1;
  const v = lo > hi ? (lo + hi) / 2 : clamp(scale * (size / 2 - point), lo, hi);
  // Clamping against a zero bound yields -0, which is numerically fine but
  // serializes into the document as "-0". Normalize so saved keyframes read
  // cleanly.
  return v === 0 ? 0 : v;
}

/**
 * Where a fitted picture's content sits inside a canvas-shaped box, per axis.
 *
 * The renderer fits a mismatched source into the canvas (aspect preserved,
 * centred, bars transparent) rather than stretching it; this is the one place
 * that geometry is computed, shared by the zoom clamps and the cursor mapping
 * so they cannot disagree about where the picture ends.
 */
export function contentBox(
  video: { width: number; height: number },
  canvas: Size
): { x0: number; x1: number; y0: number; y1: number; k: number } {
  if (!(video.width > 0) || !(video.height > 0)) {
    return { x0: 0, x1: canvas.width, y0: 0, y1: canvas.height, k: 1 };
  }
  const k = Math.min(canvas.width / video.width, canvas.height / video.height);
  const w = video.width * k;
  const h = video.height * k;
  const x0 = (canvas.width - w) / 2;
  const y0 = (canvas.height - h) / 2;
  return { x0, x1: x0 + w, y0, y1: y0 + h, k };
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

/*
 * How fast the camera may move, in canvas-widths per second — a PEAK, not a
 * mean, because peaks are what the eye objects to. The ratios convert a curve's
 * mean speed to its peak: springOut does 90% of its travel in the first ~30% of
 * its time, so its peak runs ~3x its mean, and a ramp that "fits" on paper can
 * still whip. The quintic smootherstep used for pans tops out lower.
 *
 * These exist because the emitter used to let geometry alone pick the speed:
 * a pan between two nearby-in-time holds took whatever gap happened to be
 * left, however short — 900 pixels in a fifth of a second was a legal and
 * common outcome, and it read as the camera being yanked.
 */
export const MAX_CAM_SPEED = 2.2;
export const SPRING_PEAK = 3.0;
export const PAN_PEAK = 1.9;

/** The most a hold may shorten to buy its neighbouring pan travel time. */
const HOLD_GIVE = 0.4;

/**
 * Compile held zooms into scale/x/y keyframes.
 *
 * Shared with SmartFocus, which differs only in where its holds come from —
 * so an auto zoom and a hand-placed one produce identically-shaped motion, and
 * there is one copy of the rules about when to pull back and when to pan.
 *
 * `canvas` lets the emitter reason about speed in canvas-widths; without it
 * the speed caps are skipped (offsets alone don't say how big a pixel is).
 *
 * `adaptSpeed` is on for auto camera work and OFF for hand-placed stops: the
 * caps exist to protect timings nobody chose, and a ramp the user typed into
 * the panel is not one of those. It also keeps the panel's round-trip honest —
 * readZoomStops must recover exactly what applyZoomStops wrote.
 */
export function zoomKeyframes(
  holds: ZoomHold[],
  duration: number,
  canvas?: Size,
  adaptSpeed = false
): Record<string, Keyframe[]> {
  if (!holds.length) return {};
  const speedAware = adaptSpeed && !!canvas && canvas.width > 0;

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
      // A push to a far corner at a deep zoom travels much further than one to
      // a spot near centre, and a fixed ramp makes the far one proportionally
      // faster. Stretch the ramp (never shrink it) until the spring's peak
      // stays under the cap — bounded, so a pathological travel cannot turn a
      // zoom into a slow cruise.
      let ramp = h.ramp;
      if (speedAware) {
        const travel = Math.hypot(h.x, h.y) + 0.35 * canvas!.width * Math.max(0, h.scale - 1);
        const need = (SPRING_PEAK * travel) / (MAX_CAM_SPEED * canvas!.width);
        ramp = Math.min(Math.max(h.ramp, need), 1.8 * h.ramp);
      }
      // On a clip too short for two full ramps, the ramp itself has to give —
      // there is no arrangement that fits otherwise.
      ramp = Math.min(ramp, duration / 2);
      const start = clamp(h.start, ramp, duration - ramp);
      const end = clamp(h.end, start, duration - ramp);
      return { ...h, start, end, ramp };
    })
    .filter((h) => h.end > h.start);

  if (!sorted.length) return {};

  /*
   * A pan between holds happens in the gap between them, so the gap IS the pan
   * duration — and gaps come from when the user happened to click, not from
   * how far apart the targets are. When the gap is too short for the travel,
   * the holds on either side each give up a bounded slice of their dwell to
   * widen it. Losing a beat of looking at something already on screen is
   * cheap; the pan is the part being watched.
   */
  if (speedAware) {
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const h = sorted[i];
      const gap = h.start - prev.end;
      if (gap >= prev.ramp + h.ramp) continue; // pulls out to full frame instead
      const from = prev.path?.length ? prev.path[prev.path.length - 1] : prev;
      const dist = Math.hypot(h.x - from.x, h.y - from.y);
      const need = (PAN_PEAK * dist) / (MAX_CAM_SPEED * canvas!.width);
      const deficit = need - gap;
      if (deficit <= 0) continue;
      const a = Math.min(deficit / 2, HOLD_GIVE * (prev.end - prev.start));
      const b = Math.min(deficit - a, HOLD_GIVE * (h.end - h.start));
      prev.end -= a;
      h.start += b;
    }
  }

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
    // A hold either sits still or drifts along its path. The drift's points
    // come from a spring simulation whose SAMPLES already carry the
    // acceleration — so they are joined linearly. Easing between them would
    // re-add a stop at every keyframe, which is exactly the stop-go pulse the
    // spring replaced. They are never sprung either: every point is clamped to
    // what the scale can cover, and overshooting a clamped point is what shows
    // background.
    const path = (h.path ?? []).filter((p) => p.t > h.start && p.t < h.end);
    at(h.start, h.scale, h.x, h.y, "linear");
    for (const p of path) at(p.t, h.scale, p.x, p.y, "linear");
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
  return { ...rest, ...zoomKeyframes(stops.map((s) => holdFromStop(s, canvas)), duration, canvas) };
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
