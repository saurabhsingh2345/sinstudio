import type { CursorSample, CursorSidecar } from "./cursor";
import type { Keyframe } from "./types";

// Auto-zoom derived from what the user was actually doing — Camtasia's
// SmartFocus, built on the pointer track we already record.
//
// The output is ordinary scale/x/y keyframes on the clip, not a special effect.
// That is the whole point: the zooms land on the timeline as diamonds you can
// drag, retime, re-ease or delete one at a time. An "auto focus" that produced
// motion nobody could adjust would be worse than no auto focus, because the one
// zoom it got wrong is the one you most need to fix.
//
// Position uses only x/y/scale, all of which are already keyframable, so this
// needs no engine changes on either side.

export interface SmartFocusOptions {
  /** Scale held while focused. 1.5–1.8 reads as emphasis without disorienting. */
  zoom: number;
  /** Seconds to move in and back out. */
  ramp: number;
  /** Shortest time worth staying zoomed; briefer than this reads as a twitch. */
  minHold: number;
  /** Clicks are the strongest signal that something mattered. */
  useClicks: boolean;
  /** A pointer parked somewhere is usually pointing at something. */
  useDwell: boolean;
  dwellTime: number; // seconds stationary to count as dwell
  dwellRadius: number; // px (video space) the pointer may wander and still dwell
  /** Events closer than this in time and space are one focus, not several. */
  clusterGap: number;
  clusterRadius: number;
  ease: string;
}

export const SMART_FOCUS_DEFAULTS: SmartFocusOptions = {
  zoom: 1.6,
  ramp: 0.7,
  minHold: 1.2,
  useClicks: true,
  useDwell: true,
  dwellTime: 1.0,
  dwellRadius: 60,
  clusterGap: 2.5,
  clusterRadius: 320,
  ease: "easeInOut",
};

export interface FocusSegment {
  start: number; // seconds, when the zoom should be held from
  end: number;
  x: number; // focus point, video px
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Press edges — a held button is one click, not one per sample. */
export function clickEvents(samples: CursorSample[]): FocusSegment[] {
  const out: FocusSegment[] = [];
  let prev = 0;
  for (const s of samples) {
    const down = s.down ?? 0;
    if (down !== 0 && prev === 0) out.push({ start: s.t / 1000, end: s.t / 1000, x: s.x, y: s.y });
    prev = down;
  }
  return out;
}

/**
 * Runs where the pointer stayed inside `radius` for at least `minTime`.
 *
 * The sampler already collapsed motionless spans to a heartbeat, so a dwell
 * shows up as a few samples far apart in time and close in space — which is
 * exactly what this looks for.
 */
export function dwellEvents(samples: CursorSample[], radius: number, minTime: number): FocusSegment[] {
  const out: FocusSegment[] = [];
  let i = 0;
  while (i < samples.length) {
    const a = samples[i];
    let j = i + 1;
    let sx = a.x;
    let sy = a.y;
    let n = 1;
    // Measured against where the run STARTED, not a running centroid. A
    // centroid recomputed as the run grows follows the pointer, so a slow drift
    // never breaks the test and the whole recording collapses into one "dwell".
    while (j < samples.length && Math.hypot(samples[j].x - a.x, samples[j].y - a.y) <= radius) {
      sx += samples[j].x;
      sy += samples[j].y;
      n++;
      j++;
    }
    const span = (samples[j - 1].t - a.t) / 1000;
    if (span >= minTime && n > 1) {
      out.push({ start: a.t / 1000, end: samples[j - 1].t / 1000, x: Math.round(sx / n), y: Math.round(sy / n) });
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

/** Merge events near in both time and space into single focus segments. */
export function clusterEvents(events: FocusSegment[], gap: number, radius: number): FocusSegment[] {
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const out: FocusSegment[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.start - last.end <= gap && Math.hypot(e.x - last.x, e.y - last.y) <= radius) {
      // Weight toward the running centroid so a cluster settles on its middle
      // rather than drifting to whichever event happened to be last.
      last.end = Math.max(last.end, e.end);
      last.x = Math.round((last.x + e.x) / 2);
      last.y = Math.round((last.y + e.y) / 2);
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

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
 * Build focus segments from a pointer track. Exposed separately from keyframe
 * emission so the UI can say how many zooms it found before committing them.
 */
export function findFocusSegments(
  track: Pick<CursorSidecar, "samples">,
  duration: number,
  opts: SmartFocusOptions
): FocusSegment[] {
  const events: FocusSegment[] = [];
  if (opts.useClicks) events.push(...clickEvents(track.samples));
  if (opts.useDwell) events.push(...dwellEvents(track.samples, opts.dwellRadius, opts.dwellTime));
  if (!events.length) return [];

  let segs = clusterEvents(events, opts.clusterGap, opts.clusterRadius);

  // Give every segment at least the minimum hold, then drop any that the
  // widening pushed into its neighbour — overlapping zooms fight each other.
  segs = segs.map((s) => {
    const short = opts.minHold - (s.end - s.start);
    if (short <= 0) return s;
    return { ...s, start: Math.max(0, s.start - short / 2), end: s.end + short / 2 };
  });

  // Only genuinely overlapping segments collapse. Segments that are merely
  // close stay distinct and get panned between (see focusKeyframes) — averaging
  // two positions would aim the zoom at the midpoint between two UI elements,
  // which is a place nothing happened.
  const out: FocusSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      continue;
    }
    out.push({ ...s });
  }
  // Never key past the clip.
  return out
    .map((s) => ({ ...s, start: clamp(s.start, 0, duration), end: clamp(s.end, 0, duration) }))
    .filter((s) => s.end > s.start);
}

/**
 * Turn focus segments into scale/x/y keyframes.
 *
 * `video` is the pointer track's own pixel space and `canvas` the project's, so
 * a 4K capture on a 1080p canvas focuses on the right place.
 */
export function focusKeyframes(
  segs: FocusSegment[],
  duration: number,
  video: { width: number; height: number },
  canvas: { width: number; height: number },
  opts: SmartFocusOptions
): Record<string, Keyframe[]> {
  if (!segs.length) return {};
  const sx = video.width > 0 ? canvas.width / video.width : 1;
  const sy = video.height > 0 ? canvas.height / video.height : 1;

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

  const offsets = segs.map((seg) => ({
    ox: centerOffset(seg.x * sx, canvas.width, opts.zoom),
    oy: centerOffset(seg.y * sy, canvas.height, opts.zoom),
  }));

  // Start wide, so the first zoom has something to move from.
  at(0, 1, 0, 0, opts.ease);

  segs.forEach((seg, i) => {
    const { ox, oy } = offsets[i];
    const prev = segs[i - 1];

    if (!prev) {
      const inStart = Math.max(0, seg.start - opts.ramp);
      if (inStart > 0) at(inStart, 1, 0, 0, opts.ease);
    } else if (seg.start - prev.end >= opts.ramp * 2) {
      // Room to breathe: pull back to full frame between the two.
      at(prev.end + opts.ramp, 1, 0, 0, opts.ease);
      at(Math.max(prev.end + opts.ramp, seg.start - opts.ramp), 1, 0, 0, opts.ease);
    }
    // Otherwise stay zoomed and let x/y carry the move — a pan straight from
    // one target to the next. Pulling out and back in over a gap this short
    // reads as a flinch, and both endpoints are clamped at the same scale, so
    // interpolating between them can never expose background either.
    at(seg.start, opts.zoom, ox, oy, "linear");
    at(seg.end, opts.zoom, ox, oy, opts.ease);
  });

  const lastSeg = segs[segs.length - 1];
  at(Math.min(duration, lastSeg.end + opts.ramp), 1, 0, 0, opts.ease);
  if (scale[scale.length - 1].t < duration) at(duration, 1, 0, 0, "linear");

  return { scale, x: xs, y: ys };
}

/** Convenience: track → keyframes in one step. */
export function smartFocus(
  track: Pick<CursorSidecar, "samples" | "video">,
  duration: number,
  canvas: { width: number; height: number },
  opts: SmartFocusOptions = SMART_FOCUS_DEFAULTS
): { keyframes: Record<string, Keyframe[]>; segments: FocusSegment[] } {
  const segments = findFocusSegments(track, duration, opts);
  return { keyframes: focusKeyframes(segments, duration, track.video, canvas, opts), segments };
}
