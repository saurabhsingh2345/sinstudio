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

/*
 * even() for a POSITION rather than a size — mirrors render.evenOrigin.
 *
 * The distinction is the one cropPixels already makes: "a size floors at 2; an
 * origin does not, because zero is where an untrimmed edge legitimately starts."
 * A centred picture that exactly fills the canvas has an origin of 0, and even()
 * returned 2 for it — invisible while padding had a 6% floor, and 2px off the
 * corner (plus 2px over the far edge) the moment the padding is none.
 */
const evenOrigin = (v: number) => {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n--;
  return n < 0 ? 0 : n;
};

export const backdropInset = (b: Backdrop): number =>
  clamp(b.inset || BACKDROP_DEFAULTS.inset, 0, BACKDROP_DEFAULTS.maxInset);

/*
 * Zero means "unset" in this struct.
 *
 * schema.Backdrop says so and both renderers substitute the default for it, so
 * a slider dragged to zero writes 0, the renderer reads 0 as unset, and 6%
 * padding comes straight back — which is why padding, square corners and "no
 * shadow" were all unreachable from the panel.
 *
 * A NEGATIVE value is the documented way to say "really none" (schema.go spells
 * it out for Shadow), and both sides already clamp one to zero:
 * clampF(-1, 0, max) is 0 in Go and clamp(-1, 0, max) is 0 here. The contract
 * existed and was golden-tested; only the UI never used it.
 */
export const BACKDROP_NONE = -1;

/** Document value → the number the panel shows. Absent/0 is the default; negative reads as 0. */
export const backdropShown = (v: number | undefined, dflt: number): number =>
  v === undefined || v === 0 ? dflt : v < 0 ? 0 : v;

/** Panel value → what to store, so a slider at zero stays at zero. */
export const backdropStored = (v: number): number => (v === 0 ? BACKDROP_NONE : v);

/**
 * Shadow strength with the sentinel resolved — mirrors renderBackdropPNG's
 * `if shadow == 0 { shadow = def }; if shadow > 0 {...}`.
 *
 * The preview used `b.shadow || 0.55` directly, so a negative value reached CSS
 * as `rgba(0,0,0,-0.42)`. That does produce no shadow, but by being an invalid
 * declaration the browser throws away — which is luck, not agreement.
 */
export const backdropShadow = (b: Backdrop): number =>
  clamp(backdropShown(b.shadow, BACKDROP_DEFAULTS.shadow), 0, 1);

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
  return { x: evenOrigin((w - cw) / 2), y: evenOrigin((h - ch) / 2), w: cw, h: ch, radius };
}

/** The wallpaper as CSS — flat when color2 is absent, like the renderer. */
export function backdropCSS(b: Backdrop): string {
  const c1 = b.color1 || BACKDROP_DEFAULTS.color1;
  return b.color2 ? `linear-gradient(180deg, ${c1}, ${b.color2})` : c1;
}
