// bridge — pure derivations that project the real EditDoc (track/clip model)
// into the shapes the spine UI needs. Keeps StudioView free of ad-hoc mapping.
import type { Canvas, CaptionCue, Clip, EditDoc, Track } from "../../types";
import { clipPlayDur } from "../../types";

export type AspectKey = "9:16" | "4:5" | "1:1" | "4:3" | "3:2" | "16:10" | "16:9" | "21:9";

/*
 * Canonical canvas sizes we snap to when the user picks an aspect from the UI.
 *
 * There used to be three, which is why a 3:2 laptop capture, a 16:10 window and
 * a 4:3 screen could not be matched at all: every one of them landed in bars
 * with no shape in the menu that fitted. All are 1080 on their short axis so
 * switching between them does not change the rendered detail, only the shape.
 */
export const ASPECT_CANVAS: Record<AspectKey, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "4:5": { w: 1080, h: 1350 },
  "1:1": { w: 1080, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  "3:2": { w: 1620, h: 1080 },
  "16:10": { w: 1728, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
  "21:9": { w: 2560, h: 1080 },
};

/** The same epsilon the fit and reframe code compare aspects with. */
const ASPECT_LABEL_EPS = 0.005;

/**
 * The named shape this canvas actually IS, or null when it is its own shape.
 *
 * Distinct from aspectOf, which answers "nearest" and therefore never says
 * "none of these" — so a 1512×982 canvas was labelled 16:9 in the top bar while
 * being nothing of the kind, and the label was the only thing telling anyone
 * what shape their project was.
 */
export function exactAspect(c: Canvas): AspectKey | null {
  const r = c.width / Math.max(1, c.height);
  for (const k of Object.keys(ASPECT_CANVAS) as AspectKey[]) {
    const a = ASPECT_CANVAS[k];
    const v = a.w / a.h;
    if (Math.abs(r - v) / v <= ASPECT_LABEL_EPS) return k;
  }
  return null;
}

/** What to show: the shape's name, or a custom canvas's real ratio. */
export function aspectLabel(c: Canvas): string {
  const k = exactAspect(c);
  if (k) return k;
  const r = c.width / Math.max(1, c.height);
  return `${r.toFixed(2)}:1`;
}

// aspectOf classifies an arbitrary canvas into the nearest supported aspect.
export function aspectOf(c: Canvas): AspectKey {
  const r = c.width / Math.max(1, c.height);
  const cand: [AspectKey, number][] = (Object.keys(ASPECT_CANVAS) as AspectKey[]).map((k) => [
    k,
    ASPECT_CANVAS[k].w / ASPECT_CANVAS[k].h,
  ]);
  let best: AspectKey = "16:9";
  let dist = Infinity;
  for (const [k, v] of cand) {
    const d = Math.abs(r - v);
    if (d < dist) {
      dist = d;
      best = k;
    }
  }
  return best;
}

// hueFor derives a stable hue (0..360) from an id so a clip's colour is
// consistent across renders without storing it.
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export const fmtDur = (sec: number) => `${sec.toFixed(1)}s`;

export function fmtTC(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.max(0, sec - m * 60);
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export const clipEnd = (c: Clip) => c.start + clipPlayDur(c);

// The spine's main visual sequence = the first video track (overlay as fallback).
export const primaryTrack = (d: EditDoc): Track | undefined =>
  d.tracks.find((t) => t.kind === "video") || d.tracks.find((t) => t.kind === "overlay");

export const captionTrack = (d: EditDoc) => d.tracks.find((t) => t.kind === "caption");
export const overlayTracks = (d: EditDoc) => d.tracks.filter((t) => t.kind === "overlay");
export const audioTracks = (d: EditDoc) => d.tracks.filter((t) => t.kind === "audio");

// detachedAudioFor finds the independent audio clip that was split off a given
// video clip (linked via Clip.sourceClip), if any.
export function detachedAudioFor(d: EditDoc, videoClipId: string): { trackId: string; clip: Clip } | undefined {
  for (const t of d.tracks)
    if (t.kind === "audio")
      for (const c of t.clips || []) if (c.sourceClip === videoClipId) return { trackId: t.id, clip: c };
  return undefined;
}

// volumePatch turns a gain (0..2, 1 = as recorded) into a clip patch.
//
// Volume 0 can't say "silent" on its own: the renderer reads a zero as "unset"
// and plays the clip at full gain, so a fader pulled all the way down would get
// LOUDER on export. Silence is spelled with `mute` instead. Lifting the fader
// only clears a mute this fader set (the volume was still 0) — never one that
// came from detaching the clip's audio to its own lane.
export function volumePatch(c: Clip, v: number): Partial<Clip> {
  const vol = Math.max(0, v);
  if (vol <= 0) return { volume: 0, mute: true };
  return c.mute && !c.volume ? { volume: vol, mute: false } : { volume: vol };
}

// cueForClip returns the first caption cue that overlaps a clip's timeline span.
export function cueForClip(cues: CaptionCue[] | undefined, c: Clip): CaptionCue | undefined {
  if (!cues) return undefined;
  const e = clipEnd(c);
  return cues.find((q) => q.start < e && q.end > c.start);
}
