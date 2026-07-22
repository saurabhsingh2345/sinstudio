import { describe, it, expect } from "vitest";
import { canvasForSource } from "./canvasFit";

const hd = { width: 1920, height: 1080 };

describe("canvasForSource", () => {
  /*
   * The bug this exists for: a 3:2 MacBook capture (2072x1340) in a 16:9
   * project is letterboxed with black down both sides — which looked like the
   * zoom escaping the footage and was nothing of the kind.
   */
  it("reshapes the canvas to a 3:2 screen recording", () => {
    const c = canvasForSource({ width: 2072, height: 1340 }, hd)!;
    expect(c).not.toBeNull();
    expect(c.width / c.height).toBeCloseTo(2072 / 1340, 2);
  });

  it("leaves a canvas that already matches alone", () => {
    expect(canvasForSource({ width: 1920, height: 1080 }, hd)).toBeNull();
    expect(canvasForSource({ width: 3840, height: 2160 }, hd)).toBeNull();
    // Rounding to even dimensions must not count as a mismatch.
    expect(canvasForSource({ width: 1918, height: 1080 }, hd)).toBeNull();
  });

  it("never exceeds the maximum edge", () => {
    const c = canvasForSource({ width: 5120, height: 2880 }, { width: 100, height: 100 })!;
    expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(1920);
    expect(c.width / c.height).toBeCloseTo(5120 / 2880, 2);
  });

  it("keeps a portrait recording portrait", () => {
    const c = canvasForSource({ width: 1170, height: 2532 }, hd)!;
    expect(c.height).toBeGreaterThan(c.width);
    expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(1920);
  });

  // Codecs refuse odd dimensions, or round them silently.
  it("always gives even dimensions", () => {
    for (const s of [
      { width: 2072, height: 1340 },
      { width: 1727, height: 1117 },
      { width: 999, height: 333 },
    ]) {
      const c = canvasForSource(s, hd);
      if (!c) continue;
      expect(c.width % 2).toBe(0);
      expect(c.height % 2).toBe(0);
    }
  });

  it("refuses a source with no dimensions", () => {
    expect(canvasForSource({ width: 0, height: 0 }, hd)).toBeNull();
  });
});
