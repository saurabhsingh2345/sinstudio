import type { CaptionCue } from "./types";
import type { SilenceSpan } from "./silence";

export interface ChapterSuggestion {
  t: number;
  label: string;
  source: "pause" | "caption";
}

/** Map source-time silences on a clip to timeline seconds. */
export function silencesToTimeline(
  silences: SilenceSpan[],
  clip: { start: number; in: number; out: number; speed?: number },
): { t: number; duration: number }[] {
  const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
  return silences
    .filter((s) => s.end > clip.in && s.start < clip.out)
    .map((s) => {
      const a = Math.max(s.start, clip.in);
      const mid = (a + Math.min(s.end, clip.out)) / 2;
      return {
        t: +(clip.start + (mid - clip.in) / sp).toFixed(3),
        duration: +((Math.min(s.end, clip.out) - a) / sp).toFixed(2),
      };
    });
}

/** Chapter points from long pauses and caption topic breaks. */
export function detectChapters(
  timelineSilences: { t: number; duration: number }[],
  cues: CaptionCue[],
  opts: { minPause?: number; minCaptionGap?: number } = {},
): ChapterSuggestion[] {
  const minPause = opts.minPause ?? 2.5;
  const minCaptionGap = opts.minCaptionGap ?? 4;
  const out: ChapterSuggestion[] = [];

  for (const s of timelineSilences) {
    if (s.duration >= minPause) {
      out.push({ t: s.t, label: `Pause ${formatTime(s.t)}`, source: "pause" });
    }
  }

  const sorted = [...cues].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].start - sorted[i - 1].end;
    if (gap >= minCaptionGap) {
      const label = cueTitle(sorted[i].text);
      out.push({ t: +sorted[i].start.toFixed(3), label, source: "caption" });
    }
  }

  if (sorted.length && sorted[0].start > 1) {
    out.unshift({ t: 0, label: cueTitle(sorted[0].text) || "Intro", source: "caption" });
  }

  const seen = new Set<number>();
  return out
    .sort((a, b) => a.t - b.t)
    .filter((c) => {
      const bucket = Math.round(c.t * 2);
      if (seen.has(bucket)) return false;
      seen.add(bucket);
      return true;
    });
}

function cueTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 6).join(" ");
  if (!words) return "Chapter";
  return words.length > 40 ? `${words.slice(0, 37)}…` : words;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** YouTube chapter format: 0:00 Title per line. */
export function chaptersToYouTube(chapters: ChapterSuggestion[]): string {
  return chapters.map((c) => `${formatTime(c.t)} ${c.label}`).join("\n");
}
