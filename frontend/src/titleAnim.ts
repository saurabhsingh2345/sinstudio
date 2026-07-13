import type { Keyframe, Transition, TitleAnim, TitleReveal } from "./types";

// revealedText returns the portion of a title's text visible at clip-local time
// localT, for a per-character ("typewriter") or per-word build-on. Mirrors the
// backend's reveal window (~70% of the clip) so the preview approximates export.
export function revealedText(text: string, mode: TitleReveal | undefined, localT: number, playDur: number): string {
  if (!mode) return text;
  const rd = Math.max(0.4, (playDur > 0 ? playDur : 3) * 0.7);
  const p = Math.max(0, Math.min(1, localT / rd));
  if (p >= 1) return text;
  if (mode === "word") {
    const words = text.trim() ? text.trim().split(/\s+/) : [];
    const show = Math.ceil(p * words.length);
    return words.slice(0, show).join(" ");
  }
  const runes = [...text];
  return runes.slice(0, Math.ceil(p * runes.length)).join("");
}

// buildTitleAnim turns an animation preset into concrete keyframes + transitions
// for a title of on-timeline duration D (seconds). The renderer and preview both
// already interpret keyframes/transitions, so a preset is just data — no engine
// changes needed. Keyframe times are clip-local seconds (from the clip's start).
//
// Each preset gives a symmetric entrance/exit: an ease-out build-in over `eIn`,
// a hold, and an ease-in build-out over `eOut` ending at D.
export interface TitleAnimResult {
  keyframes: Record<string, Keyframe[]>;
  transitionIn?: Transition;
  transitionOut?: Transition;
}

export const TITLE_ANIMS: { id: TitleAnim; label: string }[] = [
  { id: "none", label: "None" },
  { id: "fade", label: "Fade" },
  { id: "fadeUp", label: "Fade up" },
  { id: "pop", label: "Pop" },
  { id: "slide", label: "Slide" },
  { id: "zoom", label: "Zoom" },
];

export function buildTitleAnim(preset: TitleAnim, D: number): TitleAnimResult {
  const dur = D > 0 ? D : 3;
  // Entrance/exit windows: ~35% of the clip each, capped at 0.6s, and never
  // overlapping (leave a small hold in the middle for very short titles).
  const span = Math.min(0.6, dur * 0.35);
  const eIn = Math.max(0.1, Math.min(span, dur * 0.45));
  const eOut = Math.max(0.1, Math.min(span, dur * 0.45));
  const outStart = Math.max(eIn, dur - eOut); // exit begins here

  // opacity ramp shared by most presets: 0 → 1 (in), hold, 1 → 0 (out).
  const fade = (): Keyframe[] => [
    { t: 0, value: 0, ease: "easeOutCubic" },
    { t: eIn, value: 1, ease: "linear" },
    { t: outStart, value: 1, ease: "easeInCubic" },
    { t: dur, value: 0 },
  ];

  switch (preset) {
    case "fade":
      return { keyframes: { opacity: fade() } };

    case "fadeUp":
      return {
        keyframes: {
          opacity: fade(),
          y: [
            { t: 0, value: 60, ease: "easeOutCubic" },
            { t: eIn, value: 0, ease: "linear" },
            { t: outStart, value: 0, ease: "easeInCubic" },
            { t: dur, value: -40 },
          ],
        },
      };

    case "pop":
      return {
        keyframes: {
          opacity: [
            { t: 0, value: 0, ease: "easeOutCubic" },
            { t: eIn * 0.6, value: 1, ease: "linear" },
            { t: outStart, value: 1, ease: "easeInCubic" },
            { t: dur, value: 0 },
          ],
          scale: [
            { t: 0, value: 0.6, ease: "easeOutBack" },
            { t: eIn, value: 1, ease: "linear" },
            { t: outStart, value: 1, ease: "easeInCubic" },
            { t: dur, value: 0.85 },
          ],
        },
      };

    case "slide":
      // Pure slide via transitions (keyframing x would disable the slide filter).
      return {
        keyframes: {},
        transitionIn: { type: "slide-left", duration: eIn },
        transitionOut: { type: "slide-right", duration: eOut },
      };

    case "zoom":
      return {
        keyframes: {
          opacity: fade(),
          scale: [
            { t: 0, value: 1.0, ease: "linear" },
            { t: dur, value: 1.08 },
          ],
        },
      };

    case "none":
    default:
      return { keyframes: {} };
  }
}
