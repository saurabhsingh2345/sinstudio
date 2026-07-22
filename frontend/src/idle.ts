import type { CursorSample } from "./cursor";
import { kfValue } from "./components/studio/preview-engine";
import { FOCUS_REFERENCE_WIDTH } from "./smartFocus";
import type { Clip, Keyframe } from "./types";

/*
Idle speed-up — the timelapse pass.

A code walkthrough is minutes of typing-pauses, page loads and scrolling back
to find something. Cutting those (like silences) would be wrong: the viewer
should SEE that time passed, just not sit through it. So idle stretches are
sped up instead — the Screen Studio move — and, like everything else here, the
result is ordinary clips: split at the idle boundaries with a higher `speed`
on the idle segments, one operation, one undo, every segment still editable.

"Idle" is judged from what was recorded, on two independent signals:

  - the pointer track: no clicks, and the pointer never leaves a small radius
    (quoted at the 1920 reference and scaled, like every other radius);
  - the waveform, when there is one: nobody is talking. Speeding up narration
    turns it into chipmunks, so any audible span is never idle.
*/

export interface IdleOptions {
  /** Shortest stretch worth speeding up, seconds. */
  minIdle: number;
  /** How far the pointer may drift and still be idle — px at 1920-wide ref. */
  moveRadius: number;
  /** Peak amplitude below which the audio counts as quiet (0..1). */
  quietThreshold: number;
  /** Playback multiplier for the idle stretches. */
  factor: number;
  /** Seconds kept at normal speed on each side, so the change reads as a ramp
   *  into a timelapse rather than a stutter. */
  margin: number;
}

export const IDLE_DEFAULTS: IdleOptions = {
  minIdle: 2.0,
  moveRadius: 40,
  quietThreshold: 0.04,
  factor: 4,
  margin: 0.3,
};

/** An idle stretch, in SOURCE seconds. */
export interface IdleSpan {
  start: number;
  end: number;
}

/**
 * Idle stretches of a recording, from its pointer track and (optionally) its
 * waveform. `videoWidth` scales the radius; `peaks` may be null for a silent
 * capture, in which case the audio signal simply doesn't veto anything.
 */
export function detectIdle(
  samples: CursorSample[],
  videoWidth: number,
  peaks: number[] | null,
  assetDur: number,
  opts: IdleOptions = IDLE_DEFAULTS
): IdleSpan[] {
  if (samples.length < 2 || !(assetDur > 0)) return [];
  const radius = opts.moveRadius * ((videoWidth || FOCUS_REFERENCE_WIDTH) / FOCUS_REFERENCE_WIDTH);

  const loud = (a: number, b: number): boolean => {
    if (!peaks?.length) return false;
    const i0 = Math.max(0, Math.floor((a / assetDur) * peaks.length));
    const i1 = Math.min(peaks.length - 1, Math.ceil((b / assetDur) * peaks.length));
    for (let i = i0; i <= i1; i++) if (peaks[i] >= opts.quietThreshold) return true;
    return false;
  };

  const out: IdleSpan[] = [];
  let i = 0;
  while (i < samples.length) {
    const a = samples[i];
    let j = i;
    // Extend while the pointer stays inside the radius of where the stretch
    // began (the anchored test dwellEvents uses — a running centroid would let
    // a slow drift count as idle forever) and nobody presses anything.
    while (
      j + 1 < samples.length &&
      !samples[j + 1].down &&
      Math.hypot(samples[j + 1].x - a.x, samples[j + 1].y - a.y) <= radius
    ) {
      j++;
    }
    const s = a.t / 1000 + opts.margin;
    const e = samples[j].t / 1000 - opts.margin;
    if (e - s >= opts.minIdle && !loud(s, e)) {
      out.push({ start: +s.toFixed(3), end: +e.toFixed(3) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** What a speed-up would do to one clip. */
export interface SpeedupPlan {
  /** Source segments in order; `fast` segments get speed × factor. */
  segments: { in: number; out: number; fast: boolean }[];
  /** Play-time seconds saved. */
  saved: number;
}

export function planSpeedup(
  clip: Pick<Clip, "in" | "out" | "speed">,
  idles: IdleSpan[],
  factor: number,
  headroom = 0.05
): SpeedupPlan | null {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  if (!(factor > 1)) return null;
  const segments: { in: number; out: number; fast: boolean }[] = [];
  let cursor = clip.in;
  for (const s of [...idles].sort((a, b) => a.start - b.start)) {
    const a = Math.max(s.start, clip.in);
    const b = Math.min(s.end, clip.out);
    if (b - a < headroom) continue;
    if (a - cursor > headroom) segments.push({ in: cursor, out: a, fast: false });
    segments.push({ in: a, out: b, fast: true });
    cursor = b;
  }
  if (clip.out - cursor > headroom) segments.push({ in: cursor, out: clip.out, fast: false });
  const fastSrc = segments.filter((s) => s.fast).reduce((n, s) => n + (s.out - s.in), 0);
  if (!fastSrc) return null;
  const saved = (fastSrc / sp) * (1 - 1 / factor);
  if (saved < 0.25) return null;
  return { segments, saved: +saved.toFixed(3) };
}

/**
 * Materialize: the clips that replace the original, back to back, idle
 * segments carrying speed × factor.
 *
 * Keyframes are resampled per segment: each new clip gets its keys re-timed
 * into its own (possibly re-scaled) local time, plus a sampled key at each
 * boundary so a zoom in flight stays continuous across the splice instead of
 * snapping to wherever the next literal key sits.
 */
export function applySpeedup(clip: Clip, plan: SpeedupPlan, factor: number, mkId: () => string): Clip[] {
  const sp0 = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const out: Clip[] = [];
  let start = clip.start;
  plan.segments.forEach((seg, idx) => {
    const first = idx === 0;
    const last = idx === plan.segments.length - 1;
    const spI = seg.fast ? sp0 * factor : sp0;
    const segPlay = (seg.out - seg.in) / spI;

    const kf: Record<string, Keyframe[]> = {};
    for (const [prop, pts] of Object.entries(clip.keyframes ?? {})) {
      if (!pts.length) continue;
      // Original keys live in the ORIGINAL clip's local play time.
      const srcOf = (t: number) => clip.in + t * sp0;
      const localOf = (src: number) => (src - seg.in) / spI;
      const keys: Keyframe[] = [];
      const at = (src: number) => kfValue(pts, (src - clip.in) / sp0);
      keys.push({ t: 0, value: +at(seg.in).toFixed(4) });
      for (const p of pts) {
        const src = srcOf(p.t);
        if (src > seg.in + 1e-6 && src < seg.out - 1e-6) {
          keys.push({ ...p, t: +localOf(src).toFixed(4) });
        }
      }
      keys.push({ t: +segPlay.toFixed(4), value: +at(seg.out).toFixed(4) });
      kf[prop] = keys;
    }

    out.push({
      ...clip,
      id: first ? clip.id : mkId(),
      in: seg.in,
      out: seg.out,
      start: +start.toFixed(4),
      speed: spI === 1 ? undefined : +spI.toFixed(4),
      fadeIn: first ? clip.fadeIn : 0,
      fadeOut: last ? clip.fadeOut : 0,
      transitionIn: first ? clip.transitionIn : undefined,
      transitionOut: last ? clip.transitionOut : undefined,
      keyframes: Object.keys(kf).length ? kf : undefined,
      hold: last ? clip.hold : 0,
    });
    start += segPlay;
  });
  return out;
}
