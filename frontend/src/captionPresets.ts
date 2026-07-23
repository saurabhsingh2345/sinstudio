import type { CaptionStyle } from "./types";

export interface CaptionPreset {
  id: string;
  name: string;
  description: string;
  swatch: string;
  style: Partial<CaptionStyle>;
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "classic",
    name: "Classic",
    description: "White text, dark stroke",
    swatch: "#ffffff",
    style: { font: "Inter", size: 28, color: "#ffffff", align: "center", posY: 0.88, stroke: "rgba(0,0,0,0.85)" },
  },
  {
    id: "boxed",
    name: "Boxed",
    description: "Dark pill behind text",
    swatch: "rgba(0,0,0,0.7)",
    style: {
      font: "Inter",
      size: 26,
      color: "#ffffff",
      align: "center",
      posY: 0.9,
      background: "rgba(0,0,0,0.65)",
    },
  },
  {
    id: "bold-yellow",
    name: "Bold",
    description: "Large yellow with heavy outline",
    swatch: "#fde047",
    style: {
      font: "Inter",
      size: 36,
      color: "#fde047",
      align: "center",
      posY: 0.82,
      stroke: "rgba(0,0,0,0.95)",
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Small lower-third",
    swatch: "#e2e8f0",
    style: { font: "Inter", size: 22, color: "#e2e8f0", align: "left", posY: 0.92, stroke: "rgba(0,0,0,0.6)" },
  },
  {
    id: "social",
    name: "Social",
    description: "Centre, big type for vertical",
    swatch: "#ffffff",
    style: {
      font: "Inter",
      size: 42,
      color: "#ffffff",
      align: "center",
      posY: 0.5,
      background: "rgba(0,0,0,0.35)",
      stroke: "rgba(0,0,0,0.8)",
    },
  },
];

export function captionPresetById(id: string): CaptionPreset | undefined {
  return CAPTION_PRESETS.find((p) => p.id === id);
}

/** Merge a preset onto an existing cue style. */
export function applyCaptionPresetStyle(base: CaptionStyle, preset: CaptionPreset): CaptionStyle {
  return { ...base, ...preset.style };
}
