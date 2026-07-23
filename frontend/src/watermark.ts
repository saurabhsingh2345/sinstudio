import type { Watermark } from "./types";

// Watermark layout — the browser-side twin of render/watermark.go. Golden
// numbers asserted from both implementations (watermark.test.ts /
// TestWatermarkLayoutGolden).

export const WATERMARK_DEFAULTS = {
  size: 0.12, // fraction of canvas width
  opacity: 0.6,
  margin: 0.03, // fraction of the canvas' short side
} as const;

export interface WatermarkGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const even = (v: number) => {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n--;
  return n < 2 ? 2 : n;
};

export const watermarkOpacity = (wm: Watermark): number =>
  wm.opacity ? clamp(wm.opacity, 0.05, 1) : WATERMARK_DEFAULTS.opacity;

export function watermarkLayout(wm: Watermark, imgW: number, imgH: number, w: number, h: number): WatermarkGeom {
  const size = clamp(wm.size || WATERMARK_DEFAULTS.size, 0.02, 0.5);
  if (!(imgW > 0) || !(imgH > 0)) {
    imgW = 1;
    imgH = 1;
  }
  const ww = even(w * size);
  const wh = even((ww * imgH) / imgW);
  const m = Math.round(clamp(wm.margin || WATERMARK_DEFAULTS.margin, 0, 0.2) * Math.min(w, h));
  switch (wm.corner) {
    case "tl":
      return { x: m, y: m, w: ww, h: wh };
    case "tr":
      return { x: w - ww - m, y: m, w: ww, h: wh };
    case "bl":
      return { x: m, y: h - wh - m, w: ww, h: wh };
    default:
      return { x: w - ww - m, y: h - wh - m, w: ww, h: wh };
  }
}
