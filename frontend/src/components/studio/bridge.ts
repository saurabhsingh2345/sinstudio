// bridge — pure derivations that project the real EditDoc (track/clip model)
// into the shapes the spine UI needs. Keeps StudioView free of ad-hoc mapping.
import type { Canvas, CaptionCue, Clip, EditDoc, Track } from "../../types";
import { clipPlayDur } from "../../types";

export type AspectKey = "9:16" | "1:1" | "16:9";

// Canonical canvas sizes we snap to when the user picks an aspect from the UI.
export const ASPECT_CANVAS: Record<AspectKey, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

// aspectOf classifies an arbitrary canvas into the nearest supported aspect.
export function aspectOf(c: Canvas): AspectKey {
  const r = c.width / Math.max(1, c.height);
  const cand: [AspectKey, number][] = [
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["16:9", 16 / 9],
  ];
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

// cueForClip returns the first caption cue that overlaps a clip's timeline span.
export function cueForClip(cues: CaptionCue[] | undefined, c: Clip): CaptionCue | undefined {
  if (!cues) return undefined;
  const e = clipEnd(c);
  return cues.find((q) => q.start < e && q.end > c.start);
}
