/*
 * Making the canvas the clip's shape — the answer that was missing.
 *
 * A picture whose aspect differs from the canvas has exactly three fates today,
 * and for a recording that is already framed the way its author wants, all
 * three are wrong: Fit bars it, Fill crops it, Stretch distorts it. The fourth
 * answer costs nothing and loses nothing — reshape the CANVAS to the picture —
 * and it was unreachable because the aspect menu offered three fixed shapes and
 * the Crop panel offered only Fill.
 *
 * This is the same operation the recorder already performs on a project's first
 * clip ("the canvas takes the shape of your screen"), promoted to something you
 * can ask for at any time, on any clip.
 */

import { sourceSize } from "./crop";
import type { Asset, Canvas, Clip } from "./types";

/** Longest canvas edge we will match to. Beyond 4K the render cost is not worth it. */
export const MAX_CANVAS_EDGE = 3840;
/** Below this a canvas is a mistake, not a choice. */
export const MIN_CANVAS_EDGE = 16;

/** The same epsilon the fit/reframe code compares aspects with. */
export const SHAPE_EPS = 0.005;

/** Even, for the reason every other dimension here is: 4:2:0 cannot store an odd one. */
const even = (v: number): number => {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n--;
  return n < 2 ? 2 : n;
};

/**
 * The canvas that makes this clip fill the frame exactly — no bars, no crop.
 *
 * Measured against the clip's CROPPED size, not the asset's, because a crop
 * changes what the picture is: matching to the raw source would re-introduce
 * bars in the exact amount that was just trimmed off.
 *
 * Returns null when the source size is unknown, which stays unknown rather than
 * becoming a confident guess that reshapes the project to something arbitrary.
 */
export function canvasForClip(
  asset: Pick<Asset, "width" | "height"> | undefined,
  clip: Pick<Clip, "crop">,
  fps: number
): Canvas | null {
  const src = sourceSize(asset, clip);
  if (!src) return null;
  let { width, height } = src;
  const longest = Math.max(width, height);
  if (longest > MAX_CANVAS_EDGE) {
    // Scale both axes by one factor: the whole point is to keep the shape.
    const k = MAX_CANVAS_EDGE / longest;
    width *= k;
    height *= k;
  }
  const w = even(width);
  const h = even(height);
  if (w < MIN_CANVAS_EDGE || h < MIN_CANVAS_EDGE) return null;
  return { width: w, height: h, fps: fps > 0 ? fps : 30 };
}

export type Bars = "none" | "sides" | "topAndBottom";

/**
 * Which way this clip is barred against a canvas, if it is.
 *
 * Named rather than boolean because the two cases need different words in the
 * UI: "black down both sides" and "black above and below" are what someone
 * actually sees, and a panel that says "bars" makes them work out which.
 */
export function barsAgainst(
  asset: Pick<Asset, "width" | "height"> | undefined,
  clip: Pick<Clip, "crop">,
  canvas: { width: number; height: number } | undefined
): Bars {
  const src = sourceSize(asset, clip);
  if (!src || !canvas || !(canvas.width > 0) || !(canvas.height > 0)) return "none";
  const srcA = src.width / src.height;
  const canA = canvas.width / canvas.height;
  if (!(srcA > 0) || !(canA > 0)) return "none";
  if (Math.abs(srcA - canA) / canA <= SHAPE_EPS) return "none";
  // Narrower than the frame ⇒ it cannot reach the left and right edges.
  return srcA < canA ? "sides" : "topAndBottom";
}

/** Is this canvas already the clip's shape? Then matching would do nothing. */
export function alreadyMatches(
  asset: Pick<Asset, "width" | "height"> | undefined,
  clip: Pick<Clip, "crop">,
  canvas: { width: number; height: number } | undefined
): boolean {
  return barsAgainst(asset, clip, canvas) === "none";
}

/** "1512 × 982" — the shape, for a button that is about to change the project. */
export function canvasLabel(c: Canvas | null): string {
  return c ? `${c.width} × ${c.height}` : "";
}
