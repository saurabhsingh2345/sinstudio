import type { CursorSample, CursorSidecar } from "./cursor";
import type { Keyframe } from "./types";
import { centerOffset, centerOffsetIn, contentBox, zoomKeyframes, type ZoomHold } from "./zoomPan";

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
  /**
   * How much deeper to push for each RETURN to an area, and how far that can go.
   *
   * Coming back to the same place is the strongest statement a recording makes
   * about what matters in it — stronger than any single click, because it is the
   * difference between passing over something and working on it. A flat zoom
   * treats a spot glanced at once and a spot returned to five times identically,
   * which is the camera declining to read the room.
   */
  revisitStep: number;
  revisitMax: number;
  /**
   * Drift the held zoom along with the pointer, instead of locking it to a spot.
   *
   * A fixed hold is a tripod; this is an operator keeping the subject in frame.
   * The deadzone is what stops it becoming seasickness: nothing moves at all
   * until the pointer has genuinely travelled, and then the camera follows only
   * part of the way, so ordinary small movements inside the zoom are ignored
   * entirely.
   */
  follow: boolean;
  followDeadzone: number; // px at a 1920-wide reference, scaled like the radii
  followDamping: number; // 0..1 — how much of the excess to actually travel
  followInterval: number; // seconds between reconsiderations
  ease: string;
}

export const SMART_FOCUS_DEFAULTS: SmartFocusOptions = {
  // 1.6x was too much. On a screen recording the content is already dense —
  // text, chrome, a cursor — and pushing in that far throws most of the context
  // out of frame, so the viewer loses where they are while being shown where to
  // look. 1.35 is enough to say "here" and still keep the surroundings.
  zoom: 1.35,
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
  // A second visit is worth a noticeable push; the ceiling stops a spot that
  // was returned to a dozen times from filling the frame with four pixels.
  revisitStep: 0.18,
  revisitMax: 1.95,
  follow: true,
  // Roughly a ninth of the frame: a deliberate move across a panel crosses it,
  // reading a line of text or nudging a slider does not.
  followDeadzone: 200,
  // Under half of the excess, so the camera lags the pointer and settles behind
  // it rather than chasing it exactly — chasing exactly is what reads as jitter.
  followDamping: 0.45,
  // A hold is often only a little longer than minHold, and at 0.6 that is a
  // single reconsideration in the whole shot — following that coarse cannot
  // track anything. 0.35 gives a couple of chances in a short hold and several
  // in a long one, while still being far too slow to chase jitter.
  followInterval: 0.35,
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
  /** How many times attention landed on this area across the whole recording. */
  visits?: number;
  /** Zoom for this segment. Absent means the flat default. */
  zoom?: number;
  /** Positions to drift through during the hold, in video px. */
  follow?: { t: number; x: number; y: number }[];
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
  const kept = out
    .map((s) => ({ ...s, start: clamp(s.start, 0, duration), end: clamp(s.end, 0, duration) }))
    .filter((s) => s.end > s.start);

  /*
   * Attention that comes BACK is worth more than attention passing through.
   *
   * Events close in BOTH time and space have already been merged, so anything
   * still separate at this point is a genuine return: the pointer left and came
   * back later. Counting those purely spatially is what tells a spot glanced at
   * once apart from one being worked on, and the zoom escalates with the count.
   *
   * The radius is the cluster radius, so "the same area" means the same thing
   * here as it does when merging — and it has already been scaled to the
   * recording's own resolution.
   */
  return kept.map((seg) => {
    const visits = kept.filter((o) => Math.hypot(o.x - seg.x, o.y - seg.y) <= clusterRadius).length;
    return {
      ...seg,
      visits,
      // Scaled to the recording for the same reason the radii are: a deadzone
      // in fixed pixels is a different gesture on every capture resolution.
      follow: opts.follow
        ? followPath(track.samples, seg, opts.followDeadzone * k, opts.followDamping, opts.followInterval)
        : undefined,
      // First visit is the baseline; each return past it pushes further, to a
      // ceiling that keeps some context in frame.
      //
      // The ceiling bounds the ESCALATION, never the chosen zoom: asked for 2x
      // with a 1.95 ceiling, this must give 2x and not quietly less. A cap that
      // can reduce the setting above it is a setting that silently doesn't work.
      zoom: Math.min(
        Math.max(opts.zoom, opts.revisitMax),
        opts.zoom + Math.max(0, visits - 1) * opts.revisitStep
      ),
    };
  });
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

  /*
   * The video is FITTED into the canvas, not stretched — a 3:2 capture on a
   * 16:9 canvas sits centred with bars beside it. Two things follow, both of
   * which were bugs when this mapped each axis independently:
   *
   *   - a cursor position maps through one uniform factor plus the content
   *     offset, or every focus point on a mismatched recording lands a little
   *     off, worse toward the edges;
   *   - the pan clamp has to stop at the CONTENT's edge, not the box's. The
   *     box bound kept the box on screen while the camera framed the bar —
   *     zoom toward the side of the page and the frame filled with black.
   */
  const cb = contentBox(video, canvas);
  const px = (v: number) => cb.x0 + v * cb.k;
  const py = (v: number) => cb.y0 + v * cb.k;

  // Each focus point becomes a held zoom; the shared compiler decides when to
  // pull back to full frame and when to pan straight across (see zoomPan.ts).
  const holds: ZoomHold[] = segs.map((seg) => {
    // A revisited area earns a deeper push (see findFocusSegments). The pan has
    // to be clamped against THIS segment's scale, not the default — the further
    // in it goes the further it may travel, and using the wrong one would
    // either waste the headroom or run past it.
    const scale = seg.zoom && seg.zoom > 0 ? seg.zoom : opts.zoom;
    return {
      start: seg.start,
      end: seg.end,
      scale,
      x: centerOffsetIn(px(seg.x), canvas.width, scale, cb.x0, cb.x1),
      y: centerOffsetIn(py(seg.y), canvas.height, scale, cb.y0, cb.y1),
      ramp: opts.ramp,
      ease: opts.ease,
      // Every followed position goes through the same clamp as the anchor, at
      // THIS segment's scale — so drifting can no more uncover the content than
      // the fixed hold could.
      path: seg.follow?.map((f) => ({
        t: f.t,
        x: centerOffsetIn(px(f.x), canvas.width, scale, cb.x0, cb.x1),
        y: centerOffsetIn(py(f.y), canvas.height, scale, cb.y0, cb.y1),
      })),
    };
  });

  return zoomKeyframes(holds, duration, canvas, true);
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

/** Pointer position at time `t` (seconds), interpolated between samples. */
export function pointerAt(samples: CursorSample[], t: number): { x: number; y: number } | null {
  if (!samples.length) return null;
  const ms = t * 1000;
  if (ms <= samples[0]!.t) return { x: samples[0]!.x, y: samples[0]!.y };
  const last = samples[samples.length - 1]!;
  if (ms >= last.t) return { x: last.x, y: last.y };
  // The sampler emits sparsely while the pointer rests, so neighbouring samples
  // can be far apart in time; interpolating rather than snapping to the nearest
  // keeps the drift smooth across those gaps.
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= ms) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  const span = b.t - a.t;
  const u = span > 0 ? (ms - a.t) / span : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/**
 * The stiffness that makes a critically-damped spring cover `damping` of a
 * step within `interval` seconds.
 *
 * damping/interval are the two knobs the options expose — "how much of the way
 * do you go, and how quickly" — and a spring has one parameter. This solves the
 * step response 1-(1+u)e^-u = damping for u, so the exposed numbers keep the
 * meaning they had when the follower moved in discrete steps: 0.45 over 0.35s
 * still covers just under half the distance in just over a third of a second.
 */
function springStiffness(damping: number, interval: number): number {
  const d = clamp(damping, 0.05, 0.95);
  let lo = 0.01;
  let hi = 50;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (1 - (1 + mid) * Math.exp(-mid) < d) lo = mid;
    else hi = mid;
  }
  return lo / interval;
}

/**
 * Drop every point of a camera path that linear interpolation between its
 * neighbours already reproduces to within `tol` pixels.
 *
 * The simulation below runs at 30Hz because that is what smooth motion needs;
 * the document does not need 30 keyframes a second to describe it. A settled
 * camera collapses to nothing and a steady drift to a handful of segments,
 * which keeps the exported filtergraph a size ffmpeg is happy to parse.
 */
function decimatePath(
  pts: { t: number; x: number; y: number }[],
  tol: number
): { t: number; x: number; y: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const pa = pts[a];
    const pb = pts[b];
    const span = pb.t - pa.t || 1;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const u = (pts[i].t - pa.t) / span;
      const d = Math.hypot(pts[i].x - (pa.x + (pb.x - pa.x) * u), pts[i].y - (pa.y + (pb.y - pa.y) * u));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Where the camera should sit through a hold, if it is to follow the pointer.
 *
 * Returns points in video px, or an empty list when the pointer never leaves
 * the deadzone — which is the common case and deliberately costs nothing.
 *
 * The camera is a critically-damped spring aimed at a point `deadzone` short
 * of the pointer. That one sentence carries all three behaviours that matter:
 *
 *   - inside the deadzone the aim point is the camera itself, so nothing moves;
 *   - crossing the boundary by a pixel aims one pixel of travel, not a jump —
 *     the boundary stays soft;
 *   - the camera settles a deadzone's width behind the pointer rather than on
 *     top of it. Sitting on top of it is chasing, and chasing reads as jitter.
 *
 * It used to re-aim in discrete steps, one every `interval`, each segment eased
 * to a stop. Every step therefore ACCELERATED FROM REST and braked again — a
 * visible stop-go pulse, which on a real recording read as scratchy camera
 * work. A spring is smooth in position and velocity by construction, so the
 * motion carries through instead of pulsing. The simulation runs at 30Hz and is
 * decimated afterwards; what lands in the document is a few keyframes, not a
 * waveform.
 */
export function followPath(
  samples: CursorSample[],
  seg: { start: number; end: number; x: number; y: number },
  deadzone: number,
  damping: number,
  interval: number
): { t: number; x: number; y: number }[] {
  if (!(interval > 0) || !(deadzone >= 0)) return [];

  const omega = springStiffness(damping, interval);
  const dt = 1 / 30;
  let cx = seg.x;
  let cy = seg.y;
  let vx = 0;
  let vy = 0;
  const raw: { t: number; x: number; y: number }[] = [];
  let moved = false;

  // Start and end are excluded: the hold already keys its own endpoints, and a
  // point on top of either would collapse into it and lose the other.
  for (let t = seg.start + dt; t < seg.end - dt / 2; t += dt) {
    const p = pointerAt(samples, t);
    if (!p) continue;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    // Aim `deadzone` short of the pointer; inside it, aim where we already are
    // (the spring then just bleeds off whatever velocity it still carries).
    const pull = d > deadzone ? (d - deadzone) / d : 0;
    const ax = omega * omega * dx * pull - 2 * omega * vx;
    const ay = omega * omega * dy * pull - 2 * omega * vy;
    vx += ax * dt;
    vy += ay * dt;
    cx += vx * dt;
    cy += vy * dt;
    if (Math.hypot(cx - seg.x, cy - seg.y) > 0.5) moved = true;
    if (moved) raw.push({ t: +t.toFixed(3), x: cx, y: cy });
  }
  if (!moved) return [];

  // Tolerance rides the deadzone because both are quoted in the recording's own
  // pixels: the caller has already scaled the deadzone to this capture, and a
  // fixed tolerance would over-thin a 4K path and under-thin a 720p one.
  const tol = Math.max(1, deadzone / 100);
  return decimatePath(raw, tol).map((p) => ({ t: p.t, x: Math.round(p.x), y: Math.round(p.y) }));
}
