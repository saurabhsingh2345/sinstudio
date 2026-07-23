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
 * Cover-fit geometry — picture fills the canvas, excess cropped.
 * Screen recordings use this as the camera viewport.
 */
export function coverBox(
  video: { width: number; height: number },
  canvas: Size
): { x0: number; x1: number; y0: number; y1: number; k: number } {
  if (!(video.width > 0) || !(video.height > 0)) {
    return { x0: 0, x1: canvas.width, y0: 0, y1: canvas.height, k: 1 };
  }
  const k = Math.max(canvas.width / video.width, canvas.height / video.height);
  const w = video.width * k;
  const h = video.height * k;
  const x0 = (canvas.width - w) / 2;
  const y0 = (canvas.height - h) / 2;
  return { x0, x1: x0 + w, y0, y1: y0 + h, k };
}

export const videoToCanvas = (v: number, origin: number, k: number) => origin + v * k;

/** Clamp pan so scaled content always covers the frame. */
export function clampPanOffset(off: number, size: number, scale: number, c0: number, c1: number): number {
  if (scale <= 1.001) return off === 0 ? 0 : off;
  const hi = (size * (scale - 1)) / 2 - scale * c0;
  const lo = (size * (1 + scale)) / 2 - scale * c1;
  if (lo > hi) return (lo + hi) / 2;
  return clamp(off, lo, hi);
}

export function clipScaleAt(
  clip: Pick<import("./types").Clip, "start" | "transform" | "keyframes">,
  t: number
): number {
  const localT = t - clip.start;
  const kf = clip.keyframes?.scale;
  if (kf?.length) return Math.max(0, kfValue(kf, localT));
  return clip.transform.scale || 1;
}

export function isZoomActive(
  clip: Pick<import("./types").Clip, "start" | "transform" | "keyframes">,
  t: number,
  eps = 1.02
): boolean {
  return clipScaleAt(clip, t) > eps;
}

/**
 * Force a rectangle to be something the engine can actually express: the canvas
 * aspect (one `scale` drives both axes, so a differently-shaped rectangle is
 * not representable) and wholly inside the picture.
 *
 * Containment is not cosmetic — it is the same rule `centerOffset` clamps to.
 * A rectangle hanging over the edge would ask to pan further than the zoom
 * allows, and the frame's edge would come into view as visible background.
 *
 * `video` is the source's own pixel size. Without it the canvas is assumed to be
 * all picture, which is only true when the recording shares the canvas's shape.
 * A 3456x2234 capture on a 16:9 canvas is pillarboxed, and a rectangle allowed
 * over a bar asks the camera to frame background — the same fault `centerOffsetIn`
 * exists to prevent, arriving by way of the rectangle instead of the clamp.
 */
export function clampRect(rect: Rect, canvas: Size, video?: Size): Rect {
  const aspect = canvas.width / canvas.height;
  const cb = contentBox(video ?? canvas, canvas);
  // The widest canvas-shaped rectangle that still fits inside the picture. On a
  // pillarboxed source the width runs out first, on a letterboxed one the height
  // does, so both bounds have to be considered.
  const maxW = Math.min(cb.x1 - cb.x0, (cb.y1 - cb.y0) * aspect);
  const w = clamp(rect.w, Math.min(canvas.width / MAX_ZOOM, maxW), maxW);
  const h = w / aspect;
  return {
    x: clamp(rect.x, cb.x0, cb.x1 - w),
    y: clamp(rect.y, cb.y0, cb.y1 - h),
    w,
    h,
  };
}

/** The rectangle that fills the frame at scale 1 — i.e. no zoom at all. */
export const fullFrame = (canvas: Size): Rect => ({ x: 0, y: 0, w: canvas.width, h: canvas.height });

/** Rectangle → the transform that makes it fill the frame. */
export function rectToTransform(
  rect: Rect,
  canvas: Size,
  video?: Size
): { scale: number; x: number; y: number } {
  const r = clampRect(rect, canvas, video);
  const cb = contentBox(video ?? canvas, canvas);
  const scale = clamp(canvas.width / r.w, 1, MAX_ZOOM);
  return {
    scale,
    // Clamped against the CONTENT's edges, not the box's — the box bound keeps
    // the box on screen while letting the camera frame a bar, which is how a
    // hand-placed zoom on a mismatched recording used to fill with background.
    // SmartFocus has always done this; the panel is catching up.
    x: centerOffsetIn(r.x + r.w / 2, canvas.width, scale, cb.x0, cb.x1),
    y: centerOffsetIn(r.y + r.h / 2, canvas.height, scale, cb.y0, cb.y1),
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
export const rectForZoom = (
  zoom: number,
  centre: { x: number; y: number },
  canvas: Size,
  video?: Size
): Rect => {
  const s = clamp(zoom, 1, MAX_ZOOM);
  const w = canvas.width / s;
  const h = canvas.height / s;
  return clampRect({ x: centre.x - w / 2, y: centre.y - h / 2, w, h }, canvas, video);
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

export const holdFromStop = (stop: ZoomStop, canvas: Size, video?: Size): ZoomHold => ({
  start: stop.start,
  end: stop.end,
  ramp: stop.ramp,
  ease: stop.ease,
  ...rectToTransform(stop.rect, canvas, video),
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
/** Peak speed for auto camera (smartFocus); gentler than manual zoom. */
export const AUTO_CAM_SPEED = 1.15;
export const SPRING_PEAK = 3.0;
export const PAN_PEAK = 1.9;

/** The most a hold may shorten to buy its neighbouring pan travel time. */
const HOLD_GIVE = 0.4;
const AUTO_HOLD_GIVE = 0.55;

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

  const camSpeed = speedAware ? AUTO_CAM_SPEED : MAX_CAM_SPEED;
  const holdGive = speedAware ? AUTO_HOLD_GIVE : HOLD_GIVE;

  const pushKf = (arr: Keyframe[], t: number, value: number, ease: string) => {
    const tt = +Math.max(0, Math.min(duration, t)).toFixed(3);
    const prev = arr[arr.length - 1];
    if (prev && prev.t >= tt) {
      prev.t = tt;
      prev.value = value;
      prev.ease = ease;
      return;
    }
    arr.push({ t: tt, value, ease });
  };
  const atScale = (t: number, s: number, ease: string) => pushKf(scale, t, +s.toFixed(4), ease);
  const atPan = (t: number, ox: number, oy: number, ease: string) => {
    const prec = speedAware ? 2 : 0;
    pushKf(xs, t, +ox.toFixed(prec), ease);
    pushKf(ys, t, +oy.toFixed(prec), ease);
  };
  const atAll = (t: number, s: number, ox: number, oy: number, easeScale: string, easePan?: string) => {
    atScale(t, s, easeScale);
    atPan(t, ox, oy, easePan ?? (speedAware ? "easeInOut" : easeScale));
  };
  /** Legacy single-ease writer for manual zoom path. */
  const at = (t: number, s: number, ox: number, oy: number, ease: string) => atAll(t, s, ox, oy, ease);

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
        const need = (SPRING_PEAK * travel) / (camSpeed * canvas!.width);
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
      const need = (PAN_PEAK * dist) / (camSpeed * canvas!.width);
      const deficit = need - gap;
      if (deficit <= 0) continue;
      const a = Math.min(deficit / 2, holdGive * (prev.end - prev.start));
      const b = Math.min(deficit - a, holdGive * (h.end - h.start));
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
  const rampEase = (h: ZoomHold) => safeEase(h.ease);

  // Start wide, so the first zoom has something to move from.
  atAll(0, 1, 0, 0, out(sorted[0]), out(sorted[0]));

  sorted.forEach((h, i) => {
    const prev = sorted[i - 1];

    if (!prev) {
      const inStart = Math.max(0, h.start - h.ramp);
      if (inStart > 0) {
        atScale(inStart, 1, h.ease);
        atPan(inStart, 0, 0, rampEase(h));
      }
      atPan(h.start, h.x, h.y, "linear");
      atScale(h.start, h.scale, "linear");
    } else if (h.start - prev.end >= prev.ramp + h.ramp) {
      const pullAt = prev.end + prev.ramp;
      atAll(pullAt, 1, 0, 0, out(h), out(h));
      const inStart = Math.max(pullAt, h.start - h.ramp);
      if (inStart > pullAt) {
        atScale(inStart, 1, h.ease);
        atPan(inStart, 0, 0, rampEase(h));
      }
      atPan(h.start, h.x, h.y, "linear");
      atScale(h.start, h.scale, "linear");
    } else if (speedAware) {
      atPan(h.start, h.x, h.y, "easeInOut");
      atScale(h.start, h.scale, "linear");
    } else {
      atPan(h.start, h.x, h.y, "linear");
      atScale(h.start, h.scale, "linear");
    }
    // Hold drift path — samples are joined linearly; easing between them re-adds jitter.
    const path = (h.path ?? []).filter((p) => p.t > h.start && p.t < h.end);
    for (const p of path) {
      atPan(p.t, p.x, p.y, "linear");
      atScale(p.t, h.scale, "linear");
    }
    const last = path[path.length - 1];
    atPan(h.end, last?.x ?? h.x, last?.y ?? h.y, out(h));
    atScale(h.end, h.scale, out(h));
  });

  const last = sorted[sorted.length - 1];
  atAll(Math.min(duration, last.end + last.ramp), 1, 0, 0, out(last), out(last));
  if (scale[scale.length - 1].t < duration) atAll(duration, 1, 0, 0, "linear", "linear");

  return { scale, x: xs, y: ys };
}

/** Write stops into a clip's keyframes, leaving properties zoom doesn't drive alone. */
export function applyZoomStops(
  existing: Record<string, Keyframe[]> | undefined,
  stops: ZoomStop[],
  duration: number,
  canvas: Size,
  video?: Size
): Record<string, Keyframe[]> | undefined {
  const rest = { ...(existing ?? {}) };
  delete rest.scale;
  delete rest.x;
  delete rest.y;
  if (!stops.length) return Object.keys(rest).length ? rest : undefined;
  return {
    ...rest,
    ...zoomKeyframes(stops.map((s) => holdFromStop(s, canvas, video)), duration, canvas),
  };
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
  canvas: Size,
  video?: Size
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
      rect: clampRect(transformToRect(a.value, ax, ay, canvas), canvas, video),
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
