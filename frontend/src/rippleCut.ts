import type { Clip, EditDoc, Track } from "./types";
import { clipPlayDur, newId } from "./types";

/** Map timeline seconds to source seconds inside a clip. */
function srcAt(c: Clip, t: number): number {
  const sp = c.speed && c.speed > 0 ? c.speed : 1;
  return c.in + (t - c.start) * sp;
}

/**
 * Remove timeline span [start, end) and ripple everything after it left.
 * Returns replacement clips for one track (may be fewer/more than input).
 */
export function rippleCutTrackClips(clips: Clip[], start: number, end: number, mkId: () => string): Clip[] {
  if (!(end > start)) return clips;
  const len = end - start;
  const out: Clip[] = [];

  for (const c of clips) {
    const cs = c.start;
    const ce = cs + clipPlayDur(c);

    if (ce <= start) {
      out.push(c);
      continue;
    }
    if (cs >= end) {
      out.push({ ...c, start: +(cs - len).toFixed(4) });
      continue;
    }
    if (cs >= start && ce <= end) {
      continue;
    }

    if (cs < start && ce > end) {
      const left: Clip = {
        ...c,
        out: +srcAt(c, start).toFixed(4),
        fadeOut: 0,
        transitionOut: undefined,
        hold: 0,
      };
      const right: Clip = {
        ...c,
        id: mkId(),
        in: +srcAt(c, end).toFixed(4),
        start: +start.toFixed(4),
        fadeIn: 0,
        transitionIn: undefined,
        hold: c.hold,
      };
      if (left.out - left.in > 0.05) out.push(left);
      if (right.out - right.in > 0.05) out.push(right);
      continue;
    }

    if (cs < start && ce <= end) {
      const trimmed: Clip = { ...c, out: +Math.max(c.in, srcAt(c, start)).toFixed(4), fadeOut: c.fadeOut, hold: 0 };
      if (trimmed.out - trimmed.in > 0.05) out.push(trimmed);
      continue;
    }

    // cs >= start && ce > end
    out.push({
      ...c,
      in: +srcAt(c, end).toFixed(4),
      start: +start.toFixed(4),
      fadeIn: 0,
      transitionIn: undefined,
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Apply a ripple cut across every track and shift/remove overlapping caption cues. */
export function rippleCutDoc(doc: EditDoc, start: number, end: number): EditDoc {
  if (!(end > start)) return doc;
  const len = end - start;
  const mkId = () => newId("c_");

  const tracks = doc.tracks.map((t) => ({
    ...t,
    clips: t.clips?.length ? rippleCutTrackClips(t.clips, start, end, mkId) : t.clips,
  }));

  const cap = tracks.find((t) => t.kind === "caption");
  let cues = cap?.cues ?? [];
  if (cues.length) {
    cues = cues
      .filter((q) => q.end <= start || q.start >= end)
      .map((q) =>
        q.start >= end
          ? { ...q, start: +(q.start - len).toFixed(3), end: +(q.end - len).toFixed(3) }
          : q
      );
    tracks.forEach((t) => {
      if (t.kind === "caption") t.cues = cues;
    });
  }

  const markers = (doc.markers ?? [])
    .filter((m) => m.t < start || m.t >= end)
    .map((m) => (m.t >= end ? { ...m, t: +(m.t - len).toFixed(3) } : m));

  return { ...doc, tracks, markers: markers.length ? markers : doc.markers };
}

/** Gaps on the timeline with no visual clip coverage (B-roll opportunities). */
export function timelineGaps(doc: EditDoc, minGap = 1.5): { start: number; end: number; duration: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const t of doc.tracks) {
    if (t.kind !== "video" && t.kind !== "overlay") continue;
    for (const c of t.clips ?? []) {
      if (c.disabled || c.title || c.annotation) continue;
      spans.push({ start: c.start, end: c.start + clipPlayDur(c) });
    }
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i].start <= last.end) last.end = Math.max(last.end, spans[i].end);
    else merged.push(spans[i]);
  }
  const total = merged[merged.length - 1].end;
  const gaps: { start: number; end: number; duration: number }[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start - cursor >= minGap) {
      gaps.push({ start: cursor, end: m.start, duration: +(m.start - cursor).toFixed(2) });
    }
    cursor = Math.max(cursor, m.end);
  }
  if (total - cursor >= minGap) {
    gaps.push({ start: cursor, end: total, duration: +(total - cursor).toFixed(2) });
  }
  return gaps;
}
