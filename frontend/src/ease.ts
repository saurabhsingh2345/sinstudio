// Keyframe easing curves — the browser-side twins of render.easeProgress (Go)
// and newaniAdv/lib/motion.ts. Preview uses ease() so scrubbing matches export;
// Inspector uses EASINGS/EASE_LABEL to offer the per-keyframe curve picker.

export const EASINGS = [
  "linear",
  "easeInOut",
  "easeInCubic",
  "easeOutCubic",
  "easeOutBack",
  "easeOutElastic",
  "springOut",
] as const;

export type Easing = (typeof EASINGS)[number];

export const EASE_LABEL: Record<string, string> = {
  linear: "Linear",
  easeInOut: "Smooth",
  easeInCubic: "Ease in",
  easeOutCubic: "Ease out",
  easeOutBack: "Back",
  easeOutElastic: "Elastic",
  springOut: "Spring",
};

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

// ease maps normalized progress t∈[0,1] through the named curve. Shapes mirror
// render.easeProgress exactly so preview and the exported render agree.
export function ease(name: string | undefined, t: number): number {
  const x = clamp01(t);
  switch (name) {
    case "easeInCubic":
      return x * x * x;
    case "easeOutCubic":
      return 1 - Math.pow(1 - x, 3);
    case "easeInOut": // quintic smootherstep
      return x * x * x * (x * (x * 6 - 15) + 10);
    case "easeOutBack": {
      const c3 = 2.70158;
      return 1 + c3 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
    }
    case "easeOutElastic": {
      if (x === 0 || x === 1) return x;
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
    }
    case "springOut": {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return 1 + Math.pow(2, -9 * x) * Math.sin((x * 8 - 0.75) * (Math.PI / 1.7)) * 0.9;
    }
    default: // linear
      return x;
  }
}
