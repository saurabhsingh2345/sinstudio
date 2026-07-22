import type { Backdrop } from "./types";

// Backdrop scenes — the browser-side twin of backend/internal/render/backdrop.go.
//
// The geometry here MUST agree with backdropLayout in Go: the exporter
// composites the picture into that rectangle and the preview positions a DOM
// node onto this one. backdrop.test.ts and TestBackdropLayoutGolden assert the
// same numbers from both implementations.

export const BACKDROP_DEFAULTS = {
  color1: "#23262f",
  inset: 0.06,
  radius: 14, // px at a 1080-high reference
  shadow: 0.55,
  maxInset: 0.35,
} as const;

/** Wallpaper presets the panel offers. The first is the enable-time default. */
export const BACKDROP_PRESETS: { name: string; color1: string; color2: string }[] = [
  { name: "Indigo", color1: "#4f46e5", color2: "#9333ea" },
  { name: "Ocean", color1: "#0ea5e9", color2: "#1e3a8a" },
  { name: "Sunset", color1: "#f97316", color2: "#c2410c" },
  { name: "Forest", color1: "#10b981", color2: "#065f46" },
  { name: "Slate", color1: "#334155", color2: "#0f172a" },
  { name: "Mono", color1: "#18181b", color2: "" },
];

export interface BackdropGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number; // canvas px
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Mirrors render.even: floor to an even number, floor of 2 (4:2:0 chroma).
const even = (v: number) => {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n--;
  return n < 2 ? 2 : n;
};

export const backdropInset = (b: Backdrop): number =>
  clamp(b.inset || BACKDROP_DEFAULTS.inset, 0, BACKDROP_DEFAULTS.maxInset);

/**
 * Where the picture sits on the canvas: fitted into the inset box, centred,
 * aspect kept, dimensions even. Unknown source dims are treated as
 * canvas-shaped so a dimensionless doc still lays out.
 */
export function backdropLayout(b: Backdrop, vw: number, vh: number, w: number, h: number): BackdropGeom {
  if (!(vw > 0) || !(vh > 0)) {
    vw = w;
    vh = h;
  }
  const inset = backdropInset(b);
  const availW = w * (1 - 2 * inset);
  const availH = h * (1 - 2 * inset);
  const k = Math.min(availW / vw, availH / vh);
  const cw = even(vw * k);
  const ch = even(vh * k);
  const radius = clamp((b.radius || BACKDROP_DEFAULTS.radius) * (h / 1080), 0, Math.min(cw, ch) / 2);
  return { x: even((w - cw) / 2), y: even((h - ch) / 2), w: cw, h: ch, radius };
}

/** The wallpaper as CSS — flat when color2 is absent, like the renderer. */
export function backdropCSS(b: Backdrop): string {
  const c1 = b.color1 || BACKDROP_DEFAULTS.color1;
  return b.color2 ? `linear-gradient(180deg, ${c1}, ${b.color2})` : c1;
}
