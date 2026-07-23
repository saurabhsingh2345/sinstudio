import type { Bubble } from "./types";

// Webcam bubbles — the browser-side twin of backend/internal/render/bubble.go.
// bubble.test.ts and TestBubbleLayoutGolden assert the same numbers from both
// implementations; the preview positions a DOM node onto exactly the rectangle
// the exporter composites into.

export const BUBBLE_DEFAULTS = {
  size: 0.28, // diameter as a fraction of canvas height
  maxSize: 0.9,
  border: 6, // px at a 1080-high reference
  borderColor: "#ffffff",
  shadow: 0.5,
  cardRadius: 0.18, // rounded shape: corner radius as a fraction of diameter
} as const;

export interface BubbleGeom {
  d: number; // diameter, canvas px, even
  x: number; // top-left when centred
  y: number;
  radius: number; // corner radius, canvas px
  border: number; // ring width, canvas px
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const even = (v: number) => {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n--;
  return n < 2 ? 2 : n;
};

export function bubbleLayout(b: Bubble, w: number, h: number): BubbleGeom {
  const size = clamp(b.size || BUBBLE_DEFAULTS.size, 0.05, BUBBLE_DEFAULTS.maxSize);
  const d = even(h * size);
  const radius = b.shape === "rounded" ? d * BUBBLE_DEFAULTS.cardRadius : d / 2;
  let border = b.border ?? 0;
  if (border === 0) border = BUBBLE_DEFAULTS.border;
  if (border < 0) border = 0;
  return {
    d,
    x: even((w - d) / 2),
    y: even((h - d) / 2),
    radius,
    border: (border * h) / 1080,
  };
}

export type BubbleCorner = "tl" | "tr" | "bl" | "br" | "center";

/**
 * The transform offsets that snap a (centred-by-construction) bubble into a
 * corner. Deliberately nothing more than x/y values: a snapped bubble is an
 * ordinary clip transform, still draggable and still keyframable.
 */
export function bubbleCorner(corner: BubbleCorner, g: BubbleGeom, w: number, h: number): { x: number; y: number } {
  const m = Math.round(0.04 * h);
  const dx = Math.round((w - g.d) / 2 - m);
  const dy = Math.round((h - g.d) / 2 - m);
  switch (corner) {
    case "tl":
      return { x: -dx, y: -dy };
    case "tr":
      return { x: dx, y: -dy };
    case "bl":
      return { x: -dx, y: dy };
    case "br":
      return { x: dx, y: dy };
    default:
      return { x: 0, y: 0 };
  }
}
