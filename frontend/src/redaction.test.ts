import { describe, it, expect } from "vitest";
import {
  REDACT_KINDS,
  clampRedaction,
  newRedaction,
  normRedaction,
  previewBlurPx,
  redactionStrength,
} from "./redaction";

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
