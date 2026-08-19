import { describe, it, expect } from "vitest";
import {
  cropLayout,
  cropPixels,
  cropToAspect,
  fillsFrame,
  fitMode,
  isEmptyCrop,
  sourceSize,
} from "./crop";
import type { Asset, Clip } from "./types";

const asset = (w: number, h: number) => ({ width: w, height: h }) as Asset;
const clip = (over: Partial<Clip> = {}) => over as Clip;

describe("cropPixels", () => {
  // Mirrors schema.Crop.Pixels — the two are the same arithmetic in two
  // languages, and a divergence shows up as a preview and an export a pixel
  // apart with nothing to explain why.
  it("matches the Go side on the headline case", () => {
    expect(cropPixels({ top: 0.25 }, 1920, 1080)).toEqual({ x: 0, y: 270, w: 1920, h: 810 });
  });

  it("keeps every value even", () => {
    const r = cropPixels({ top: 0.137, left: 0.211, right: 0.073, bottom: 0.019 }, 1913, 1077);
    for (const [k, v] of Object.entries(r)) expect(v % 2, k).toBe(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1913);
    expect(r.y + r.h).toBeLessThanOrEqual(1077);
  });

  // An untrimmed edge starts at zero. Rounding it up to two — which the size
  // rule does, and must — would shift every uncropped axis by a pixel.
  it("leaves an untrimmed origin at zero", () => {
    expect(cropPixels({ bottom: 0.1 }, 1920, 1080).x).toBe(0);
    expect(cropPixels({ right: 0.1 }, 1920, 1080).y).toBe(0);
  });

  it("cannot be dragged down to nothing", () => {
    const r = cropPixels({ top: 0.8, bottom: 0.8, left: 0.95, right: 0.95 }, 1920, 1080);
    expect(r.w).toBeGreaterThanOrEqual(2);
    expect(r.h).toBeGreaterThanOrEqual(2);
    expect(r.w).toBeLessThanOrEqual(1920);
  });
});

describe("sourceSize", () => {
  it("is the picture's size, not the file's", () => {
    expect(sourceSize(asset(1920, 1080), clip({ crop: { top: 0.25 } }))).toEqual({ width: 1920, height: 810 });
    expect(sourceSize(asset(1920, 1080), clip())).toEqual({ width: 1920, height: 1080 });
  });

  // An unprobed asset stays unknown. Turning 0x0 into a confident 2x2 would
  // letterbox such a clip into a speck rather than leaving it alone.
  it("stays undefined for an asset of unknown size", () => {
    expect(sourceSize(asset(0, 0), clip({ crop: { top: 0.2 } }))).toBeUndefined();
    expect(sourceSize(undefined, clip())).toBeUndefined();
  });
});

describe("fitMode", () => {
  // Mirrors prefitFilter and schema.FitCovers: an unset fit letterboxes, full
  // stop. It used to fill wherever the camera was working the clip, and since
  // every screen recording carries cursor effects that cropped a quarter off any
  // recording whose shape did not match the canvas, silently.
  it("letterboxes unless told otherwise", () => {
    expect(fitMode("")).toBe("fit");
    expect(fitMode(undefined)).toBe("fit");
    expect(fitMode("fit")).toBe("fit");
    expect(fitMode("fill")).toBe("fill");
    expect(fitMode("stretch")).toBe("stretch");
  });

  it("reports which modes leave no bars to protect a pan from", () => {
    expect(fillsFrame("")).toBe(false);
    expect(fillsFrame(undefined)).toBe(false);
    expect(fillsFrame("fit")).toBe(false);
    expect(fillsFrame("fill")).toBe(true);
    expect(fillsFrame("stretch")).toBe(true);
  });
});

describe("cropLayout", () => {
  /*
   * The element is sized to the WHOLE source and positioned so the surviving
   * rectangle lands where it belongs, with the parent clipping the rest. One
   * rule for all three fits; object-fit could express two of them and neither
   * with a crop applied.
   */
  it("places an uncropped source exactly as contain would", () => {
    // 16:9 source into a 16:9 box: fills it, no offset.
    const l = cropLayout(undefined, { width: 1920, height: 1080 }, 640, 360, "fit");
    expect(l.window).toEqual({ left: 0, top: 0, width: 640, height: 360 });
    expect(l.media).toEqual({ left: 0, top: 0, width: 640, height: 360 });
  });

  it("letterboxes a source that is the wrong shape", () => {
    // 1:1 source into a 2:1 box: a 180-wide picture centred in 360.
    const l = cropLayout(undefined, { width: 1000, height: 1000 }, 360, 180, "fit");
    expect(l.window.width).toBeCloseTo(180);
    expect(l.window.height).toBeCloseTo(180);
    expect(l.window.left).toBeCloseTo(90);
    expect(l.window.top).toBeCloseTo(0);
  });

  /*
   * The bug this shape exists to prevent, caught by running the real thing.
   *
   * A fitted crop's window is SMALLER than the clip's box. Clipping to the box
   * — which is what a single overflow:hidden parent does — leaves the trimmed
   * edges on screen, filling what should be letterbox bars with exactly the
   * pixels the crop was asked to remove. The crop then appears to do nothing,
   * while the export (which really does drop them) disagrees.
   */
  it("clips to the crop, not to the clip's box, when fitting", () => {
    // A 3456x2234 screen recording with the top quarter cut, into a 16:9 box.
    const l = cropLayout({ top: 0.25 }, { width: 3456, height: 2234 }, 696, 392, "fit");
    // The surviving picture is wider than 16:9, so it letterboxes: the window
    // is shorter than the box and centred in it.
    expect(l.window.height).toBeLessThan(392);
    expect(l.window.top).toBeCloseTo((392 - l.window.height) / 2, 6);
    expect(l.window.width).toBeCloseTo(696, 6);
    // And the removed edge hangs above the window, where it is clipped away.
    expect(l.media.top).toBeLessThan(0);
    expect(l.media.height).toBeGreaterThan(l.window.height);
  });

  /*
   * The other half. Cut the top quarter off a 16:9 recording and fill: the
   * surviving 1920x810 covers a 16:9 box, so it is scaled up and the removed
   * band sits above the window.
   */
  it("covers the box when filling, with the cut edge outside the window", () => {
    const l = cropLayout({ top: 0.25 }, { width: 1920, height: 1080 }, 1920, 1080, "fill");
    const k = 1080 / 810; // scale needed to cover on the short axis
    // The window covers the box and overflows it sideways — which is what fill
    // means, and why the clip's box clips too rather than only the window.
    expect(l.window.height).toBeCloseTo(1080, 6);
    expect(l.window.width).toBeCloseTo(1920 * k, 6);
    expect(l.window.left).toBeCloseTo((1920 - 1920 * k) / 2, 6);
    expect(l.window.top).toBeCloseTo(0, 6);
    // The removed 270px of source, scaled, sits above the window.
    expect(l.media.width / 1920).toBeCloseTo(k, 3);
    expect(l.media.top).toBeCloseTo(-270 * k, 1);
  });

  it("scales the axes apart only when stretching", () => {
    const l = cropLayout({ top: 0.25 }, { width: 1920, height: 1080 }, 1920, 1080, "stretch");
    // The surviving 1920x810 is pulled to the full 1920x1080 box.
    expect(l.window).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
    expect(l.media.width).toBeCloseTo(1920);
    expect(l.media.height).toBeCloseTo(1080 * (1080 / 810), 1);
  });

  it("survives a box or source with no size", () => {
    const l = cropLayout(undefined, { width: 0, height: 0 }, 100, 50, "fit");
    expect(l.window).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    expect(l.media).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });
});

describe("cropToAspect", () => {
  it("takes the sides off something too wide", () => {
    const c = cropToAspect({ width: 1920, height: 1080 }, 1); // to square
    expect(c.left).toBeCloseTo(c.right!);
    expect(c.top ?? 0).toBe(0);
    // 1080 of 1920 kept, so 420px a side.
    expect(c.left! * 1920).toBeCloseTo(420, 0);
  });

  it("takes the top and bottom off something too tall", () => {
    const c = cropToAspect({ width: 1080, height: 1920 }, 16 / 9);
    expect(c.top).toBeCloseTo(c.bottom!);
    expect(c.left ?? 0).toBe(0);
  });

  it("does nothing when the shapes already agree", () => {
    expect(isEmptyCrop(cropToAspect({ width: 1920, height: 1080 }, 16 / 9))).toBe(true);
    // And a rounding-error mismatch is not worth cropping for.
    expect(isEmptyCrop(cropToAspect({ width: 1918, height: 1080 }, 16 / 9))).toBe(true);
  });
});

/*
The fill focus, which decides what a filled clip throws away.

The numbers here are the exporter's: fitted by height, a 900-wide source stays
900 in a 640 frame, so 260px overflow. At focus 0 the window starts at the left
edge, at 1 it ends at the right, at 0.5 it is centred — exactly ffmpeg's
crop=(iw-W)*f, which is what keeps the preview showing the part the export keeps.
*/
describe("cropLayout fill focus", () => {
  const src = { width: 900, height: 360 };

  const leftOf = (focus: [number, number]) =>
    cropLayout(undefined, src, 640, 360, "fill", focus).window.left;

  it("hangs the overflow where the focus says", () => {
    expect(leftOf([0, 0.5])).toBe(0); // keep the left edge
    expect(leftOf([1, 0.5])).toBe(-260); // keep the right edge
    expect(leftOf([0.5, 0.5])).toBe(-130); // centred
  });

  it("defaults to centred, which is what it always did", () => {
    expect(cropLayout(undefined, src, 640, 360, "fill").window.left).toBe(-130);
  });

  it("clamps a focus that has run off the end", () => {
    expect(leftOf([-3, 0.5])).toBe(0);
    expect(leftOf([9, 0.5])).toBe(-260);
  });

  // A letterboxed picture has no overflow to choose between, and offsetting it
  // would slide the picture around inside its own bars — a different feature,
  // and not one anyone asked for.
  it("ignores the focus when the clip letterboxes", () => {
    const tall = { width: 360, height: 900 };
    const centred = cropLayout(undefined, tall, 640, 360, "fit").window.left;
    expect(cropLayout(undefined, tall, 640, 360, "fit", [0, 0]).window.left).toBe(centred);
  });
});
