import type { Track } from "./types";

/** CSS background for the canvas background track (solid or vertical gradient). */
export function trackBackgroundCSS(track?: Track | null, fallback = "#000"): string {
  const c1 = track?.backgroundColor || fallback;
  const c2 = track?.backgroundColor2;
  return c2 ? `linear-gradient(180deg, ${c1}, ${c2})` : c1;
}
