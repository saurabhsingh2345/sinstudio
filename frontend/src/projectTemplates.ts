export type WizardAspect = "16:9" | "4:3" | "9:16";

export interface ProjectTemplateDraft {
  name: string;
  aspect: WizardAspect;
  bgType: "solid" | "gradient";
  bgColor: string;
  bgColor2: string;
  fps: number;
  segments: number;
  segmentSeconds: number;
  videoTracks: number;
  audioTrack: boolean;
  subtitleTrack: boolean;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  swatch: string;
  draft: ProjectTemplateDraft;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "screen-recording",
    name: "Screen recording",
    description: "16:9 canvas, one video lane — record and polish",
    swatch: "linear-gradient(135deg, #0f172a, #1e293b)",
    draft: {
      name: "Screen recording",
      aspect: "16:9",
      bgType: "solid",
      bgColor: "#0f172a",
      bgColor2: "#1e293b",
      fps: 30,
      segments: 1,
      segmentSeconds: 30,
      videoTracks: 1,
      audioTrack: true,
      subtitleTrack: false,
    },
  },
  {
    id: "tutorial",
    name: "Tutorial",
    description: "Two video lanes + captions for walkthroughs",
    swatch: "linear-gradient(135deg, #4f46e5, #0ea5e9)",
    draft: {
      name: "Tutorial",
      aspect: "16:9",
      bgType: "gradient",
      bgColor: "#4f46e5",
      bgColor2: "#0ea5e9",
      fps: 30,
      segments: 1,
      segmentSeconds: 15,
      videoTracks: 2,
      audioTrack: true,
      subtitleTrack: true,
    },
  },
  {
    id: "podcast",
    name: "Podcast / voice",
    description: "Audio-first with a simple 16:9 frame",
    swatch: "#18181b",
    draft: {
      name: "Podcast",
      aspect: "16:9",
      bgType: "solid",
      bgColor: "#18181b",
      bgColor2: "#27272a",
      fps: 30,
      segments: 1,
      segmentSeconds: 60,
      videoTracks: 1,
      audioTrack: true,
      subtitleTrack: true,
    },
  },
  {
    id: "social-short",
    name: "Social vertical",
    description: "9:16 for Shorts, Reels and Stories",
    swatch: "linear-gradient(180deg, #ec4899, #8b5cf6)",
    draft: {
      name: "Vertical short",
      aspect: "9:16",
      bgType: "gradient",
      bgColor: "#ec4899",
      bgColor2: "#8b5cf6",
      fps: 30,
      segments: 1,
      segmentSeconds: 15,
      videoTracks: 1,
      audioTrack: true,
      subtitleTrack: true,
    },
  },
];

export function projectTemplateById(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}
