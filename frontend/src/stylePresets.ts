import type { Backdrop, CursorFX } from "./types";
import type { SmartFocusOptions } from "./smartFocus";

/** One-click look: backdrop scene + cursor polish (+ optional auto-zoom tuning). */
export interface StylePreset {
  id: string;
  name: string;
  description: string;
  /** CSS background for the preset card swatch. */
  swatch: string;
  backdrop?: Backdrop;
  cursor?: CursorFX;
  /** When set, re-runs auto-zoom with these options after applying the look. */
  smartFocus?: Partial<SmartFocusOptions>;
  /** Motion blur strength for camera keyframe moves (0..1). */
  motionBlur?: number;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "product-demo",
    name: "Product demo",
    description: "Indigo frame, soft shadow, smooth pointer",
    swatch: "linear-gradient(135deg, #4f46e5, #9333ea)",
    backdrop: { color1: "#4f46e5", color2: "#9333ea", inset: 0.08, radius: 16, shadow: 0.6 },
    cursor: {
      clicks: { color: "#ffffff", size: 120 },
      pointer: { smoothing: 0.55, style: "arrow", size: 44 },
    },
    smartFocus: { zoom: 1.32, ramp: 1.05, minHold: 1.1, ease: "easeInOut", followDamping: 0.22, followInterval: 0.62 },
    motionBlur: 0.45,
  },
  {
    id: "tutorial",
    name: "Tutorial",
    description: "Calm ocean backdrop, gentle zooms",
    swatch: "linear-gradient(135deg, #0ea5e9, #1e3a8a)",
    backdrop: { color1: "#0ea5e9", color2: "#1e3a8a", inset: 0.06, radius: 12, shadow: 0.5 },
    cursor: {
      clicks: { color: "#e0f2fe", size: 130 },
      pointer: { smoothing: 0.4, style: "arrow" },
    },
    smartFocus: { zoom: 1.28, ramp: 1.1, minHold: 1.2, useDwell: true, ease: "easeInOut", followDamping: 0.24, followInterval: 0.6 },
    motionBlur: 0.35,
  },
  {
    id: "bold",
    name: "Bold",
    description: "Warm sunset frame, vivid click rings",
    swatch: "linear-gradient(135deg, #f97316, #c2410c)",
    backdrop: { color1: "#f97316", color2: "#c2410c", inset: 0.1, radius: 20, shadow: 0.65 },
    cursor: {
      clicks: { color: "#fde68a", size: 160, duration: 0.5 },
      pointer: { smoothing: 0.35, style: "ring", color: "#ffffff" },
    },
    smartFocus: { zoom: 1.36, ramp: 1.0, minHold: 1.0, ease: "easeInOut", followDamping: 0.26, followInterval: 0.55 },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Dark slate, click rings only",
    swatch: "linear-gradient(135deg, #334155, #0f172a)",
    backdrop: { color1: "#334155", color2: "#0f172a", inset: 0.04, radius: 8, shadow: 0.35 },
    cursor: { clicks: { color: "#ffffff", size: 100 } },
  },
  {
    id: "clean",
    name: "Clean",
    description: "Flat mono — no frame, just polish",
    swatch: "#18181b",
    backdrop: { color1: "#18181b", inset: 0.03, radius: 6, shadow: 0.25 },
    cursor: {
      clicks: {},
      pointer: { smoothing: 0.5 },
    },
  },
];

export function presetById(id: string): StylePreset | undefined {
  return STYLE_PRESETS.find((p) => p.id === id);
}
