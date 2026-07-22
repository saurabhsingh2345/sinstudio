import type { ChromaKey } from "./types";

// Chroma key defaults and the keying maths, shared by the preview shader and
// the inspector. The twin of backend/internal/render/chroma.go.
//
// The preview APPROXIMATES, as it does for every other effect: the export is
// authoritative. What it must not approximate is how the CONTROLS behave — if
// nudging similarity does something different in each half, the sliders are
// being tuned against a picture that isn't the one being exported, and the
// numbers you settle on are wrong. So the thresholds mean the same thing on
// both sides even though the pixels differ slightly.

/** The standard chroma green (Rosco 4600), which is what a bought screen is. */
export const CHROMA_COLOR = "#00b140";

export const CHROMA_SIMILARITY = 0.25;
export const CHROMA_BLEND = 0.05;

export interface ResolvedChroma {
  color: string;
  similarity: number;
  blend: number;
  spill: number;
}

/** Defaults the renderer applies, made explicit so the preview can agree. */
export function resolveChroma(c: ChromaKey): ResolvedChroma {
  return {
    color: c.color || CHROMA_COLOR,
    // 0 means unset, not "key nothing" — the same rule the renderer follows,
    // because JSON cannot distinguish an omitted number from a zero one.
    similarity: c.similarity && c.similarity > 0 ? c.similarity : CHROMA_SIMILARITY,
    blend: c.blend && c.blend > 0 ? c.blend : CHROMA_BLEND,
    spill: c.spill ?? 0,
  };
}

/** A new key, starting from the colour a real screen actually is. */
export function newChroma(): ChromaKey {
  return { color: CHROMA_COLOR, similarity: CHROMA_SIMILARITY, blend: CHROMA_BLEND, spill: 0 };
}

/** #rrggbb → 0..1 RGB. Anything unparseable falls back to chroma green. */
export function hexToRGB(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hexToRGB(CHROMA_COLOR);
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const p = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

/**
 * The chroma part of a colour: its U and V, dropping luma.
 *
 * Distance is measured here rather than in RGB for the reason the renderer
 * picks `chromakey` over `colorkey`: a green screen is never evenly lit, and in
 * RGB the dim corner and the hot-spot under the lamp are far apart, so one
 * threshold cannot cover both without growing wide enough to eat the subject.
 *
 * Note this REDUCES the sensitivity to lighting, it does not remove it — U and
 * V still scale with intensity, so the corner and the hot-spot are closer
 * together but not identical. ffmpeg's chromakey has the same property, which
 * is what keeps the two halves agreeing.
 */
export function toUV(r: number, g: number, b: number): [number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return [(b - y) * 0.565, (r - y) * 0.713];
}

/**
 * How opaque a pixel stays, 0..1 — the CPU twin of the preview's shader.
 *
 * Exists to be testable: a fragment shader cannot be unit-tested here, and the
 * behaviour that matters (a screen pixel vanishes, a subject pixel does not,
 * and the band between them is gradual) is worth pinning somewhere.
 */
export function keyAlpha(
  pixel: [number, number, number],
  key: [number, number, number],
  similarity: number,
  blend: number
): number {
  const [pu, pv] = toUV(...pixel);
  const [ku, kv] = toUV(...key);
  const d = Math.hypot(pu - ku, pv - kv);
  if (d <= similarity) return 0;
  const soft = Math.max(blend, 1e-4);
  return Math.min(1, (d - similarity) / soft);
}
