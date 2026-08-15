// Crop and fit — the geometry shared by the preview and, by construction, the
// export. Mirrors backend/internal/schema Crop.Pixels and
// backend/internal/render/crop.go; the two are asserted against the same
// numbers on both sides.
//
// The whole feature is one idea: a crop changes what a clip's picture IS, and
// everything that frames a picture — the letterbox, the pan clamp, the pointer
// track's coordinate space — must be told the new answer rather than each
// learning about crops separately. So sourceSize() is the single question
// "how big is this clip's picture", and it is asked before any of them.

import type { Asset, Clip, Crop, FitMode } from "./types";

/** The least a crop may leave on an axis, as a fraction. Mirrors minCropSpan. */
export const MIN_CROP_SPAN = 0.05;

export const EMPTY_CROP: Required<Crop> = { top: 0, right: 0, bottom: 0, left: 0 };

/** Crop with every edge present, for arithmetic that shouldn't handle undefined. */
export function fullCrop(c: Crop | undefined): Required<Crop> {
  return {
    top: c?.top ?? 0,
    right: c?.right ?? 0,
    bottom: c?.bottom ?? 0,
    left: c?.left ?? 0,
  };
}

/** Does this crop trim anything? An untrimmed one skips the whole pipeline. */
export function isEmptyCrop(c: Crop | undefined): boolean {
  const f = fullCrop(c);
  return f.top <= 0 && f.right <= 0 && f.bottom <= 0 && f.left <= 0;
}

/**
 * Keep opposing edges from meeting.
 *
 * Two handles dragged past each other must still leave a picture. Scaling both
 * back proportionally (rather than clamping the one being dragged) keeps the
 * crop centred where the user put it instead of snapping it to one side.
 */
function clampSpan(lo: number, hi: number): [number, number] {
  lo = Math.max(0, lo);
  hi = Math.max(0, hi);
  if (lo + hi > 1 - MIN_CROP_SPAN) {
    const k = (1 - MIN_CROP_SPAN) / (lo + hi);
    return [lo * k, hi * k];
  }
  return [lo, hi];
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve a crop against a real frame, in whole even pixels.
 *
 * Even for the same reason region recording is: H.264 stores chroma at half
 * resolution, so an odd width or offset has no representation in 4:2:0 and
 * ffmpeg rounds it silently. The preview rounds identically so the two pictures
 * cannot drift by a pixel.
 *
 * A size floors at 2; an origin does not, because zero is where an untrimmed
 * edge legitimately starts.
 */
export function cropPixels(c: Crop | undefined, frameW: number, frameH: number): CropRect {
  const evenSize = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const evenOrigin = (v: number) => Math.max(0, Math.floor(v / 2) * 2);
  if (frameW <= 0 || frameH <= 0) return { x: 0, y: 0, w: frameW, h: frameH };
  const f = fullCrop(c);
  const [l, r] = clampSpan(f.left, f.right);
  const [t, b] = clampSpan(f.top, f.bottom);
  const w = evenSize(frameW * (1 - l - r));
  const h = evenSize(frameH * (1 - t - b));
  let x = evenOrigin(frameW * l);
  let y = evenOrigin(frameH * t);
  // Origin last, so it absorbs the rounding rather than overhanging the frame.
  if (x + w > frameW) x = evenOrigin(frameW - w);
  if (y + h > frameH) y = evenOrigin(frameH - h);
  return { x, y, w, h };
}

/**
 * A clip's picture size — the thing every framing decision actually depends on.
 *
 * Unknown (a zero-dimension asset) stays unknown rather than becoming a
 * confident 2x2, which would letterbox such a clip into a speck.
 */
export function sourceSize(
  asset: Pick<Asset, "width" | "height"> | undefined,
  clip: Pick<Clip, "crop">
): { width: number; height: number } | undefined {
  if (!asset || !(asset.width > 0) || !(asset.height > 0)) return undefined;
  if (isEmptyCrop(clip.crop)) return { width: asset.width, height: asset.height };
  const r = cropPixels(clip.crop, asset.width, asset.height);
  return { width: r.w, height: r.h };
}

/**
 * Which way this clip meets the canvas, with the default resolved.
 *
 * Mirrors prefitFilter and schema.FitCovers: an unset fit letterboxes, full
 * stop. It used to fill on any clip the camera was working, and since every
 * screen recording carries cursor effects that quietly cropped a quarter off
 * any recording whose shape did not match the canvas.
 *
 * The half that made the old rule look necessary — a push-in sliding the
 * transparent bar through frame — is handled by clamping the camera to the
 * CONTENT rectangle instead, which is what fillsFrame selects below.
 */
export function fitMode(fit: FitMode | undefined): "fit" | "fill" | "stretch" {
  return fit === "fill" || fit === "stretch" ? fit : "fit";
}

/**
 * Does this clip's picture cover the whole canvas?
 *
 * Then a pan clamps to the canvas; otherwise it clamps to the content, so the
 * camera stops at the edge of the picture rather than framing the bar beside
 * it. This is the question every framing decision here actually asks, and it
 * is answered by how the picture was fitted and by nothing else — see
 * schema.FitCovers for the four different answers it used to get.
 */
export function fillsFrame(fit: FitMode | undefined): boolean {
  return fitMode(fit) !== "fit";
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CropLayout {
  /**
   * The surviving rectangle's place in the clip's box, in stage pixels. This is
   * the element that must hide its overflow — NOT the box.
   *
   * The distinction is the whole correctness of the thing. Under `fill` the
   * window covers the box, so clipping to either looks the same; under `fit` the
   * window is smaller, and clipping to the box instead leaves the trimmed edges
   * visible in what should be the letterbox bars — filling them with precisely
   * the pixels the crop was asked to remove, which reads as the crop having
   * done nothing.
   */
  window: Rect;
  /** The whole uncropped source, positioned inside that window. */
  media: Rect;
}

/**
 * Where to put the media element inside a clip's box so the cropped region
 * lands exactly where the export puts it.
 *
 * The media is always sized to the full uncropped source and offset by the
 * crop's own origin; the window is the part that survives. One rule covers all
 * three fits: fit leaves the window inside the box, fill lets it overflow, and
 * stretch scales the axes apart.
 *
 * This replaces object-fit, which could express two of the three and neither of
 * them with a crop applied.
 */
export function cropLayout(
  crop: Crop | undefined,
  src: { width: number; height: number },
  boxW: number,
  boxH: number,
  mode: "fit" | "fill" | "stretch"
): CropLayout {
  const whole = { left: 0, top: 0, width: boxW, height: boxH };
  if (!(src.width > 0) || !(src.height > 0) || !(boxW > 0) || !(boxH > 0)) {
    return { window: whole, media: whole };
  }
  const r = cropPixels(crop, src.width, src.height);
  let sx: number;
  let sy: number;
  if (mode === "stretch") {
    sx = boxW / r.w;
    sy = boxH / r.h;
  } else {
    const k = mode === "fill" ? Math.max(boxW / r.w, boxH / r.h) : Math.min(boxW / r.w, boxH / r.h);
    sx = k;
    sy = k;
  }
  // Centre the surviving rectangle in the box — which is what the exporter's
  // pad=(ow-iw)/2 does — then hang the full source off it by the crop's origin.
  return {
    window: {
      left: (boxW - r.w * sx) / 2,
      top: (boxH - r.h * sy) / 2,
      width: r.w * sx,
      height: r.h * sy,
    },
    media: {
      // `|| 0` normalises the negative zero an untrimmed edge produces, which
      // is invisible in a style but noisy in a test and in a diff.
      left: -r.x * sx || 0,
      top: -r.y * sy || 0,
      width: src.width * sx,
      height: src.height * sy,
    },
  };
}

/**
 * The crop that leaves a picture the canvas's shape.
 *
 * Trimming the long axis and keeping the short one is what "make this match the
 * others" means when the mismatch is a shape rather than a size — and it is
 * centred, because a source that is too wide is usually too wide on both sides.
 */
export function cropToAspect(src: { width: number; height: number }, aspect: number): Crop {
  if (!(src.width > 0) || !(src.height > 0) || !(aspect > 0)) return {};
  const srcA = src.width / src.height;
  if (Math.abs(srcA - aspect) / aspect < 0.005) return {};
  if (srcA > aspect) {
    // Too wide: take the sides.
    const keep = aspect / srcA;
    const side = (1 - keep) / 2;
    return { left: side, right: side };
  }
  // Too tall: take the top and bottom.
  const keep = srcA / aspect;
  const side = (1 - keep) / 2;
  return { top: side, bottom: side };
}
