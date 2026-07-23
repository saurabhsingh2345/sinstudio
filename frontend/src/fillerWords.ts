import type { CaptionCue } from "./types";

const FILLER_RE = /\b(um+|uh+|uhm+|erm+|like|you know|sort of|kind of|i mean)\b/gi;

export interface FillerHit {
  cueId: string;
  start: number;
  end: number;
  text: string;
}

/** Find caption cues that are mostly filler words. */
export function detectFillerCues(cues: CaptionCue[], maxWords = 4): FillerHit[] {
  const out: FillerHit[] = [];
  for (const cue of cues) {
    const words = cue.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const allFiller = words.every((w) => {
      FILLER_RE.lastIndex = 0;
      return FILLER_RE.test(w);
    });
    FILLER_RE.lastIndex = 0;
    if (allFiller && words.length <= maxWords) {
      out.push({ cueId: cue.id, start: cue.start, end: cue.end, text: cue.text });
    }
  }
  return out;
}

/** Strip filler tokens from cue text; returns undefined if nothing left. */
export function stripFillerText(text: string): string | undefined {
  const cleaned = text
    .replace(FILLER_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  FILLER_RE.lastIndex = 0;
  return cleaned || undefined;
}
