import type { CursorSample, CursorSidecar } from "./cursor";
import type { Keyframe } from "./types";
import { centerOffset, zoomKeyframes, type ZoomHold } from "./zoomPan";

// centerOffset moved to zoomPan (the manual zoom editor needs the same
// geometry); re-exported so it still reads as part of this module's vocabulary.
export { centerOffset };

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
  /** How far the pointer may wander and still count as parked, in px at a
   *  1920-wide reference — scaled to the recording's own width. */
  dwellRadius: number;
  /** Events closer than this in time and space are one focus, not several.
   *  clusterRadius is px at a 1920-wide reference, scaled like dwellRadius. */
  clusterGap: number;
  clusterRadius: number;
  ease: string;
}

export const SMART_FOCUS_DEFAULTS: SmartFocusOptions = {
  zoom: 1.6,
  // A zoom cycle costs ramp + hold + ramp, so these two also decide how many
  // moves fit in a clip. 0.5 was tried and is too quick: the spring already
  // front-loads the travel, so a half-second ramp arrives before the eye has
  // followed it and reads as a snap rather than a move. Nearly a second of
  // travel is what makes it look like a camera rather than a cut — the count
  // of zooms matters less than any one of them being watchable.
  ramp: 0.9,
  minHold: 1.1,
  useClicks: true,
  useDwell: true,
  dwellTime: 1.0,
  dwellRadius: 60,
  clusterGap: 2.5,
  clusterRadius: 320,
  // Spring on the way in. A smoothstep arrival reads as a machine moving a
  // camera; a small overshoot and settle reads as someone pushing in on the
  // thing they wanted you to look at. zoomKeyframes applies this ONLY to the
  // push-in — see the overshoot note there, because easing past a hard limit on
  // the way back out would show the background behind the clip.
  ease: "springOut",
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
 * Build focus segments from a pointer track. Exposed separately from keyframe
 * emission so the UI can say how many zooms it found before committing them.
 */
/**
 * The reference width the radius options are quoted against.
 *
 * dwellRadius and clusterRadius describe a distance the HAND moved, not a
 * number of pixels, so they have to be scaled to the recording they are
 * measured in. Left absolute, the same gesture behaves differently on every
 * capture: 60px is a comfortable wander on a 1080p share and a twitch on a 4K
 * one, so a Retina recording would detect far fewer dwells than the identical
 * session captured at half the resolution — the feature quietly getting worse
 * on better hardware. This is the same rule the redaction filters follow, where
 * every dimension is a fraction of the frame rather than a pixel count.
 */
export const FOCUS_REFERENCE_WIDTH = 1920;

export function findFocusSegments(
  // video is optional: a sidecar predating it, or a hand-built fixture, still
  // has to produce focus segments rather than a type error.
  track: Pick<CursorSidecar, "samples"> & Partial<Pick<CursorSidecar, "video">>,
  duration: number,
  opts: SmartFocusOptions
): FocusSegment[] {
  // Fall back to the reference rather than 0 when a sidecar carries no size:
  // scaling by zero would collapse every radius and find nothing at all.
  const vw = track.video?.width || FOCUS_REFERENCE_WIDTH;
  const k = vw / FOCUS_REFERENCE_WIDTH;
  const dwellRadius = opts.dwellRadius * k;
  const clusterRadius = opts.clusterRadius * k;

  const events: FocusSegment[] = [];
  if (opts.useClicks) events.push(...clickEvents(track.samples));
  if (opts.useDwell) events.push(...dwellEvents(track.samples, dwellRadius, opts.dwellTime));
  if (!events.length) return [];

  let segs = clusterEvents(events, opts.clusterGap, clusterRadius);

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

  // Each focus point becomes a held zoom; the shared compiler decides when to
  // pull back to full frame and when to pan straight across (see zoomPan.ts).
  const holds: ZoomHold[] = segs.map((seg) => ({
    start: seg.start,
    end: seg.end,
    scale: opts.zoom,
    x: centerOffset(seg.x * sx, canvas.width, opts.zoom),
    y: centerOffset(seg.y * sy, canvas.height, opts.zoom),
    ramp: opts.ramp,
    ease: opts.ease,
  }));

  return zoomKeyframes(holds, duration);
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
