import type { Keyframe } from "./types";

// Camera-move presets for any visual clip — the Ken Burns / tutorial-zoom moves
// that would otherwise be built one keyframe at a time. Like buildTitleAnim,
// a preset is just data: it emits keyframes the preview and the exported render
// already know how to interpret, so nothing in either engine changes.
//
// Zooms scale about the clip's ANCHOR (Transform.anchorX/Y), so the way to zoom
// into a particular UI element is to drop the anchor on it and apply a zoom —
// the preset itself is anchor-agnostic.

export type MotionPreset =
  | "kenBurns"
  | "zoomIn"
  | "zoomOut"
  | "punchIn"
  | "emphasize"
  | "panLeft"
  | "panRight"
  | "rotate360";

export const MOTION_PRESETS: { id: MotionPreset; label: string; hint: string }[] = [
  { id: "kenBurns", label: "Ken Burns", hint: "Slow zoom with a drift — brings still images to life." },
  { id: "zoomIn", label: "Zoom in", hint: "Gentle push in over the whole clip." },
  { id: "zoomOut", label: "Zoom out", hint: "Gentle pull back over the whole clip." },
  { id: "punchIn", label: "Punch in", hint: "Fast zoom to the anchor, then holds. Emphasizes a UI element." },
  { id: "emphasize", label: "Emphasize", hint: "Punch in, hold, then return — highlights a step and moves on." },
  { id: "panLeft", label: "Pan left", hint: "Drift left across a zoomed frame." },
  { id: "panRight", label: "Pan right", hint: "Drift right across a zoomed frame." },
  { id: "rotate360", label: "Rotate 360°", hint: "One full clockwise turn." },
];

// PAN_SCALE has to exceed 1 or a pan slides the frame off the canvas and reveals
// background. At scale s the frame overhangs by W*(s-1)/2 per side, so the pan
// amplitude below stays just inside that.
const PAN_SCALE = 1.15;
const PAN_FRAC = 0.07;

export function buildMotionPreset(
  preset: MotionPreset,
  D: number,
  W: number,
  H: number
): Record<string, Keyframe[]> {
  const dur = D > 0 ? D : 3;
  // Zoom/return windows: snappy but never more than a quarter of a short clip.
  const zin = Math.max(0.15, Math.min(0.6, dur * 0.25));
  const zout = Math.max(0.15, Math.min(0.6, dur * 0.25));
  const holdEnd = Math.max(zin, dur - zout);
  const panX = W * PAN_FRAC;

  switch (preset) {
    case "kenBurns":
      return {
        scale: [
          { t: 0, value: 1.0, ease: "linear" },
          { t: dur, value: 1.18 },
        ],
        x: [
          { t: 0, value: -W * 0.03, ease: "linear" },
          { t: dur, value: W * 0.03 },
        ],
        y: [
          { t: 0, value: H * 0.02, ease: "linear" },
          { t: dur, value: -H * 0.02 },
        ],
      };

    case "zoomIn":
      return {
        scale: [
          { t: 0, value: 1.0, ease: "easeInOut" },
          { t: dur, value: 1.25 },
        ],
      };

    case "zoomOut":
      return {
        scale: [
          { t: 0, value: 1.25, ease: "easeInOut" },
          { t: dur, value: 1.0 },
        ],
      };

    case "punchIn":
      return {
        scale: [
          { t: 0, value: 1.0, ease: "easeOutCubic" },
          { t: zin, value: 1.5 },
        ],
      };

    case "emphasize":
      return {
        scale: [
          { t: 0, value: 1.0, ease: "easeOutCubic" },
          { t: zin, value: 1.5, ease: "linear" },
          { t: holdEnd, value: 1.5, ease: "easeInOut" },
          { t: dur, value: 1.0 },
        ],
      };

    case "panLeft":
      return {
        scale: [{ t: 0, value: PAN_SCALE }],
        x: [
          { t: 0, value: panX, ease: "easeInOut" },
          { t: dur, value: -panX },
        ],
      };

    case "panRight":
      return {
        scale: [{ t: 0, value: PAN_SCALE }],
        x: [
          { t: 0, value: -panX, ease: "easeInOut" },
          { t: dur, value: panX },
        ],
      };

    case "rotate360":
      return {
        rotation: [
          { t: 0, value: 0, ease: "linear" },
          { t: dur, value: 360 },
        ],
      };

    default:
      return {};
  }
}
