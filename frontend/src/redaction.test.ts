import { describe, it, expect } from "vitest";
import {
  REDACT_KINDS,
  clampRedaction,
  newRedaction,
  normRedaction,
  isLiveAt,
  isTimed,
  previewBlurPx,
  redactionFromDrag,
  redactionRect,
  redactionStrength,
  redactionWindow,
  sourceFraction,
  splitRedactions,
} from "./redaction";
import { cropLayout } from "./crop";

describe("redactionStrength", () => {
  // Mirrors redactionStrength() in redaction.go, including the 0-is-unset rule:
  // the schema cannot tell an omitted field from a zero one, and a factor of 0
  // would mean the region was never actually redacted.
  it("treats zero and undefined as unset", () => {
    expect(redactionStrength(0)).toBe(redactionStrength(0.6));
    expect(redactionStrength(undefined)).toBe(redactionStrength(0.6));
  });

  it("agrees with the Go renderer at the ends of the range", () => {
    expect(redactionStrength(0.0001)).toBeCloseTo(4 + 0.0001 * 28, 6);
    expect(redactionStrength(1)).toBeCloseTo(32, 6);
  });

  it("redacts harder as the amount rises", () => {
    expect(redactionStrength(1)).toBeGreaterThan(redactionStrength(0.2));
  });

  it("clamps an out-of-range amount instead of extrapolating", () => {
    expect(redactionStrength(5)).toBe(redactionStrength(1));
  });
});

describe("previewBlurPx", () => {
  // The export resamples source pixels; the preview blurs screen pixels. Without
  // converting between the two, a 4K clip shown at 600px previews as a wall of
  // blur while its export is barely touched.
  it("scales the radius from source space into screen space", () => {
    const big = previewBlurPx(0.5, 600, 3840);
    const small = previewBlurPx(0.5, 600, 960);
    expect(small).toBeGreaterThan(big);
    expect(small / big).toBeCloseTo(4, 1);
  });

  it("never returns a radius too small to see", () => {
    expect(previewBlurPx(0.05, 10, 3840)).toBeGreaterThanOrEqual(1);
  });

  it("survives an asset whose size was never probed", () => {
    expect(Number.isFinite(previewBlurPx(0.5, 600, 0))).toBe(true);
  });
});

describe("clampRedaction", () => {
  // The renderer drops a degenerate region rather than emitting a zero-sized
  // crop (which fails the whole export), so one dragged to nothing here would
  // silently stop protecting anything.
  it("keeps a region big enough to survive the renderer", () => {
    const r = clampRedaction({ kind: "blur", x: 0.5, y: 0.5, w: 0, h: -1 });
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });

  it("keeps a region inside the frame", () => {
    const r = clampRedaction({ kind: "blur", x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    expect(r.x + r.w).toBeLessThanOrEqual(1.0001);
    expect(r.y + r.h).toBeLessThanOrEqual(1.0001);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });

  it("leaves a region that is already fine alone", () => {
    const r = { kind: "blur" as const, x: 0.25, y: 0.25, w: 0.5, h: 0.5, amount: 0.6 };
    expect(clampRedaction(r)).toEqual(r);
  });

  it("does not lose the kind or amount", () => {
    const r = clampRedaction({ kind: "pixelate", x: 2, y: 2, w: 0.3, h: 0.3, amount: 0.9 });
    expect(r.kind).toBe("pixelate");
    expect(r.amount).toBe(0.9);
  });
});

describe("normRedaction", () => {
  it("turns a region dragged up-left into a positive one", () => {
    const r = normRedaction({ kind: "blur", x: 0.6, y: 0.6, w: -0.2, h: -0.3 });
    expect(r.x).toBeCloseTo(0.4, 6);
    expect(r.y).toBeCloseTo(0.3, 6);
    expect(r.w).toBeCloseTo(0.2, 6);
    expect(r.h).toBeCloseTo(0.3, 6);
  });
});

/*
 * The mapping between a region's numbers and where it is drawn.
 *
 * A redaction is a fraction of the UNCROPPED source, because the renderer
 * applies it before the crop. So it must be measured against cropLayout's
 * `media` rect — the whole source laid out in the clip's box — and not against
 * the box, which shows only what survived the crop.
 */
describe("redactionRect", () => {
  const src = { width: 1920, height: 1080 };

  it("places a region against the box when there is no crop", () => {
    const { media } = cropLayout(undefined, src, 640, 360, "fit");
    const r = redactionRect({ kind: "blur", x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, media);
    expect(r.left).toBeCloseTo(160, 4);
    expect(r.top).toBeCloseTo(180, 4);
    expect(r.width).toBeCloseTo(320, 4);
    expect(r.height).toBeCloseTo(90, 4);
  });

  /*
   * The case the box-relative version got wrong. Cropping the left 25% away and
   * filling means the surviving picture is blown up by 4/3 and shifted left; a
   * region at x=0.25 of the SOURCE is now at the very left edge of what is
   * shown. Measured against the box it would still be drawn a quarter of the way
   * in — over the wrong thing, while the export blurs the right one.
   */
  it("follows the picture when a crop shifts and scales it", () => {
    const { media } = cropLayout({ left: 0.25 }, src, 640, 360, "stretch");
    const r = redactionRect({ kind: "blur", x: 0.25, y: 0, w: 0.25, h: 1 }, media);
    expect(r.left).toBeCloseTo(0, 3);
    // The remaining 75% of the source is stretched across 640px, so a quarter of
    // the source is now a third of the box.
    expect(r.width).toBeCloseTo(640 / 3, 3);
  });

  /*
   * The coordinate space, pinned.
   *
   * cropLayout's `media` is positioned relative to the crop WINDOW, not to the
   * clip's box — the window is the element that hides the overflow, and the
   * media hangs off its origin. So a region measured against `media` is already
   * window-relative, and subtracting the window's offset again shifts every
   * region by exactly that offset. Invisible under `fit` (where the window sits
   * at the box's origin) and wrong under `fill`, which is the mode a crop most
   * often ends in.
   */
  it("is measured in the same space as the media it sits on", () => {
    const { window: win, media } = cropLayout({ left: 0.25 }, src, 640, 360, "fill");
    // Filling a 16:9 box with a 4:3 picture overflows vertically, so the window
    // starts above the box. This is the case the offset bug hid in.
    expect(win.top).toBeCloseTo(-60, 3);
    expect(media.top).toBeCloseTo(0, 3);

    const r = redactionRect({ kind: "blur", x: 0.076, y: 0.179, w: 0.686, h: 0.118 }, media);
    // Where the media element draws that fraction of the source, in the window.
    expect(r.top).toBeCloseTo(media.top + 0.179 * media.height, 3);
    expect(r.left).toBeCloseTo(media.left + 0.076 * media.width, 3);
    // And emphatically NOT shifted by the window's own offset.
    expect(r.top).not.toBeCloseTo(media.top + 0.179 * media.height - win.top, 1);
  });

  it("round-trips with sourceFraction", () => {
    const { media } = cropLayout({ left: 0.1, top: 0.2 }, src, 800, 450, "fit");
    const region = { kind: "blur" as const, x: 0.4, y: 0.6, w: 0.2, h: 0.1 };
    const rect = redactionRect(region, media);
    const back = sourceFraction(rect.left, rect.top, media);
    expect(back.x).toBeCloseTo(region.x, 6);
    expect(back.y).toBeCloseTo(region.y, 6);
  });
});

describe("redactionFromDrag", () => {
  const src = { width: 1920, height: 1080 };

  it("turns a drag on the stage into source fractions", () => {
    const { media } = cropLayout(undefined, src, 640, 360, "fit");
    const r = redactionFromDrag({ x: 160, y: 90 }, { x: 480, y: 270 }, media);
    expect(r.x).toBeCloseTo(0.25, 6);
    expect(r.y).toBeCloseTo(0.25, 6);
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.h).toBeCloseTo(0.5, 6);
  });

  // Dragging up-and-left is how half of people draw a box.
  it("accepts a drag in any direction", () => {
    const { media } = cropLayout(undefined, src, 640, 360, "fit");
    const r = redactionFromDrag({ x: 480, y: 270 }, { x: 160, y: 90 }, media);
    expect(r.x).toBeCloseTo(0.25, 6);
    expect(r.w).toBeCloseTo(0.5, 6);
  });

  /*
   * Drawn over what is on screen, stored against the source. With a crop in play
   * these are different numbers, and storing the on-screen ones would move the
   * blur off its target the moment the export ran.
   */
  it("stores source coordinates, not screen ones, under a crop", () => {
    const { media } = cropLayout({ left: 0.5 }, src, 640, 360, "stretch");
    // The far left of what is displayed is the middle of the source.
    const r = redactionFromDrag({ x: 0, y: 0 }, { x: 64, y: 36 }, media);
    expect(r.x).toBeCloseTo(0.5, 6);
    expect(r.w).toBeCloseTo(0.05, 6);
  });

  it("never produces a region the renderer would drop", () => {
    const { media } = cropLayout(undefined, src, 640, 360, "fit");
    const r = redactionFromDrag({ x: 100, y: 100 }, { x: 100, y: 100 }, media);
    expect(r.w).toBeGreaterThan(0);
    expect(r.h).toBeGreaterThan(0);
  });
});

/*
 * Time windows — the twin of Redaction.Window/Timed in schema.go. If the preview
 * and the renderer disagree about when a region is live, a blur that is on in
 * the editor is off in the exported file.
 */
describe("redaction time windows", () => {
  it("treats zero at both ends as the whole clip", () => {
    const r = { kind: "blur" as const, x: 0, y: 0, w: 0.2, h: 0.2 };
    expect(isTimed(r, 10)).toBe(false);
    expect(redactionWindow(r, 10)).toEqual({ from: 0, to: 10 });
    expect(isLiveAt(r, 0, 10)).toBe(true);
    expect(isLiveAt(r, 9.9, 10)).toBe(true);
  });

  it("bounds a region to its own window", () => {
    const r = { kind: "blur" as const, x: 0, y: 0, w: 0.2, h: 0.2, start: 2, end: 6 };
    expect(isTimed(r, 10)).toBe(true);
    expect(redactionWindow(r, 10)).toEqual({ from: 2, to: 6 });
    expect(isLiveAt(r, 1.9, 10)).toBe(false);
    expect(isLiveAt(r, 4, 10)).toBe(true);
    expect(isLiveAt(r, 6.1, 10)).toBe(false);
  });

  // An end past the clip's own length is not a bound, it is the whole clip —
  // otherwise trimming a clip shorter would silently make a blur "timed".
  it("does not count an end beyond the clip as a bound", () => {
    const r = { kind: "blur" as const, x: 0, y: 0, w: 0.2, h: 0.2, end: 99 };
    expect(isTimed(r, 10)).toBe(false);
    expect(redactionWindow(r, 10).to).toBe(10);
  });

  it("never returns an inverted window", () => {
    const r = { kind: "blur" as const, x: 0, y: 0, w: 0.2, h: 0.2, start: 8, end: 5 };
    const w = redactionWindow(r, 10);
    expect(w.to).toBeGreaterThanOrEqual(w.from);
  });
});

/*
 * Splitting a clip. Windows are clip-local, so each half has to be rebased onto
 * its own timeline — a blur that is not rebased lands on a different moment of
 * the second half, which for a redaction means uncovering what it was hiding.
 */
describe("splitRedactions", () => {
  const box = { kind: "blur" as const, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

  it("leaves a whole-clip region whole on both halves", () => {
    const left = splitRedactions([box], 0, 4, 10);
    const right = splitRedactions([box], 4, 10, 10);
    // Still unset at both ends, rather than picking up explicit bounds that
    // happen to mean the same thing.
    expect(left).toEqual([{ ...box, start: undefined, end: undefined }]);
    expect(right).toEqual([{ ...box, start: undefined, end: undefined }]);
  });

  it("rebases a window onto the second half", () => {
    const r = { ...box, start: 5, end: 8 };
    const right = splitRedactions([r], 4, 10, 10);
    expect(right?.[0].start).toBeCloseTo(1, 4);
    expect(right?.[0].end).toBeCloseTo(4, 4);
  });

  it("clips a window that straddles the cut", () => {
    const r = { ...box, start: 2, end: 8 };
    expect(splitRedactions([r], 0, 4, 10)?.[0]).toMatchObject({ start: 2, end: undefined });
    expect(splitRedactions([r], 4, 10, 10)?.[0]).toMatchObject({ start: undefined, end: 4 });
  });

  it("drops a region the half never shows", () => {
    const early = { ...box, end: 3 };
    expect(splitRedactions([early], 4, 10, 10)).toBeUndefined();
    const late = { ...box, start: 7 };
    expect(splitRedactions([late], 0, 4, 10)).toBeUndefined();
  });

  it("keeps the geometry and strength untouched", () => {
    const r = { ...box, kind: "pixelate" as const, amount: 0.9, start: 5 };
    const got = splitRedactions([r], 4, 10, 10)?.[0];
    expect(got).toMatchObject({ kind: "pixelate", amount: 0.9, x: 0.1, w: 0.2 });
  });

  it("has nothing to say about a clip with no regions", () => {
    expect(splitRedactions(undefined, 0, 4, 10)).toBeUndefined();
    expect(splitRedactions([], 0, 4, 10)).toBeUndefined();
  });
});

describe("newRedaction", () => {
  it("lands somewhere visible and grabbable", () => {
    for (const { kind } of REDACT_KINDS) {
      const r = newRedaction(kind);
      expect(r.kind).toBe(kind);
      expect(r.w).toBeGreaterThan(0.05);
      expect(r.h).toBeGreaterThan(0.05);
      expect(r.x + r.w).toBeLessThanOrEqual(1);
      expect(r.y + r.h).toBeLessThanOrEqual(1);
      // And it must survive the clamp unchanged, or it would jump on first touch.
      expect(clampRedaction(r)).toEqual(r);
    }
  });
});
