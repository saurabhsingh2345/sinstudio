import type { Clip, Keyframe } from "./types";

/*
Silence removal — the jump-cut pass.

A tutorial take is mostly pauses: thinking, mousing, re-reading. Cutting them
by hand is razor-work repeated forty times; this finds the quiet stretches in
the waveform the timeline already draws and razors the clip around them in one
operation, one undo.

Detection runs over the SAME peaks array the timeline renders (api.waveform),
so what gets cut is what the user can already see as flat line — no second
analysis pass, no drift between what is drawn and what is removed.

Everything here is pure: detection over an array, planning over clip fields.
The store owns applying the result (ids, ripple, undo), the panel owns the
thresholds. That split is what makes the razor-math testable at all.
*/

export interface SilenceOptions {
  /** Peak amplitude (0..1 of full scale) below which a sample reads as silence. */
  threshold: number;
  /** Shortest quiet stretch worth cutting, in seconds — breaths stay. */
  minSilence: number;
  /** Seconds of quiet kept on each side of speech, so words keep their attacks. */
  pad: number;
}

export const SILENCE_DEFAULTS: SilenceOptions = {
  // 4% of full scale. Room tone on a normal mic sits under it; speech —
  // including trailing consonants — sits well over.
  threshold: 0.04,
  // Under ~0.6s a gap is pacing, not dead air. Cutting those makes the take
  // sound like it's gasping.
  minSilence: 0.6,
  pad: 0.12,
};

/** A quiet stretch, in SOURCE seconds (asset time, like clip.in/out). */
export interface SilenceSpan {
  start: number;
  end: number;
}

/**
 * Quiet stretches of an asset, from its waveform peaks.
 *
 * The pad is subtracted from BOTH ends of every run before the length test is
 * re-checked, so a cut can never reach closer than `pad` to audible content —
 * and a run that only clears `minSilence` before padding is dropped rather
 * than emitted as a sliver.
 */
export function detectSilences(peaks: number[], assetDur: number, opts: SilenceOptions = SILENCE_DEFAULTS): SilenceSpan[] {
  if (!peaks.length || !(assetDur > 0)) return [];
  const dt = assetDur / peaks.length;
  const out: SilenceSpan[] = [];
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const s = runStart * dt + opts.pad;
    const e = endIdx * dt - opts.pad;
    if (e - s >= opts.minSilence) out.push({ start: +s.toFixed(3), end: +e.toFixed(3) });
    runStart = -1;
  };
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < opts.threshold) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i);
    }
  }
  flush(peaks.length);
  return out;
}

/** The source spans a clip keeps once silences are removed, plus time saved. */
export interface SilenceCutPlan {
  /** Kept source ranges, ascending, each at least 50ms of play time. */
  kept: { in: number; out: number }[];
  /** Play-time seconds the cut saves (at the clip's own speed). */
  removed: number;
}

export function planSilenceCuts(
  clip: Pick<Clip, "in" | "out" | "speed">,
  silences: SilenceSpan[],
  headroom = 0.05
): SilenceCutPlan | null {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const kept: { in: number; out: number }[] = [];
  let cursor = clip.in;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const a = Math.max(s.start, clip.in);
    const b = Math.min(s.end, clip.out);
    if (b <= a) continue;
    if (a - cursor > headroom) kept.push({ in: cursor, out: a });
    cursor = Math.max(cursor, b);
  }
  if (clip.out - cursor > headroom) kept.push({ in: cursor, out: clip.out });
  if (!kept.length) return null;

  const keptSrc = kept.reduce((n, k) => n + (k.out - k.in), 0);
  const removed = (clip.out - clip.in - keptSrc) / sp;
  // Nothing worth doing: a "cut" that saves a blink would still shred the clip.
  if (removed < 0.1) return null;
  return { kept, removed: +removed.toFixed(3) };
}

/**
 * Materialize a plan: the clips that replace the original, back to back.
 *
 * Follows splitAtPlayhead's razor semantics exactly: keyframes are clip-local,
 * so each segment shifts them by its own offset and drops what falls before
 * it; fades and transitions survive only on the outer edges, because an inner
 * boundary is not a clip boundary the viewer should see dressed as one.
 */
export function cutClipSilences(clip: Clip, plan: SilenceCutPlan, mkId: () => string): Clip[] {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const out: Clip[] = [];
  let start = clip.start;
  plan.kept.forEach((k, idx) => {
    const first = idx === 0;
    const last = idx === plan.kept.length - 1;
    const off = (k.in - clip.in) / sp;
    const kf: Record<string, Keyframe[]> = {};
    for (const [prop, pts] of Object.entries(clip.keyframes ?? {})) {
      const shifted = pts.map((p) => ({ ...p, t: +(p.t - off).toFixed(4) })).filter((p) => p.t >= -1e-6);
      if (shifted.length) kf[prop] = shifted;
    }
    out.push({
      ...clip,
      id: first ? clip.id : mkId(),
      in: k.in,
      out: k.out,
      start: +start.toFixed(4),
      fadeIn: first ? clip.fadeIn : 0,
      fadeOut: last ? clip.fadeOut : 0,
      transitionIn: first ? clip.transitionIn : undefined,
      transitionOut: last ? clip.transitionOut : undefined,
      keyframes: Object.keys(kf).length ? kf : undefined,
      // A hold exists to cover trailing audio; only the last segment still has
      // a trailing edge in the original's sense.
      hold: last ? clip.hold : 0,
    });
    start += (k.out - k.in) / sp;
  });
  return out;
}
