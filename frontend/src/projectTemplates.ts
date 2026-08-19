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

/*
 * A template's background is the canvas BEHIND every clip, and it is not
 * decoration: it is what letterbox bars are filled with, what shows through a
 * gap in the lane, and what a fade at the head or tail of the timeline fades
 * to. The screen-recording and tutorial templates used to ship dark navy and a
 * bright indigo→sky gradient, so a screen recording sat in blue bars and every
 * fade was a wash of blue — the editor's own house colour reading as a glitch
 * in the user's video. Both are neutral now, the way every editor's canvas is;
 * the colour pickers in the wizard and the Inspector are still right there for
 * anyone who wants one.
 *
 * Social vertical keeps its gradient on purpose: a 16:9 recording on a 9:16
 * canvas is mostly background, and that one is a styled backdrop somebody chose.
 */
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "screen-recording",
    name: "Screen recording",
    description: "16:9 canvas, one video lane — record and polish",
    swatch: "linear-gradient(135deg, #000000, #121214)",
    draft: {
      name: "Screen recording",
      aspect: "16:9",
      bgType: "solid",
      bgColor: "#000000",
      bgColor2: "#121214",
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
    swatch: "linear-gradient(135deg, #000000, #17171a)",
    draft: {
      name: "Tutorial",
      aspect: "16:9",
      bgType: "solid",
      bgColor: "#000000",
      bgColor2: "#17171a",
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
