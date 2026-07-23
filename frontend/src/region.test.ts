import { describe, it, expect } from "vitest";
import { clampRegion, isWholeFrame, normRegion, regionPixels } from "./region";

describe("normRegion", () => {
  it("turns a rectangle dragged up-left into a positive one", () => {
    expect(normRegion(0.8, 0.8, -0.3, -0.2)).toEqual({ x: 0.5, y: 0.6000000000000001, w: 0.3, h: 0.2 });
  });

  it("leaves an already-positive rectangle alone", () => {
    expect(normRegion(0.1, 0.2, 0.3, 0.4)).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });
});

describe("clampRegion", () => {
  /*
   * A region reaching outside the frame is not cosmetic: VideoFrame rejects a
   * visibleRect that does not fit, and the recording fails to start at all.
   */
  it("pulls a region that overhangs back inside the frame", () => {
    const r = clampRegion({ x: 0.9, y: 0.9, w: 0.4, h: 0.4 });
    expect(r.x + r.w).toBeLessThanOrEqual(1);
    expect(r.y + r.h).toBeLessThanOrEqual(1);
  });

  it("keeps a region dragged off the edge at the edge", () => {
    const r = clampRegion({ x: -0.5, y: -0.5, w: 0.3, h: 0.3 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBe(0.3);
  });

  it("refuses a degenerate region rather than recording nothing", () => {
    expect(clampRegion({ x: 0.5, y: 0.5, w: 0, h: 0 }).w).toBeGreaterThan(0);
  });

  it("leaves a region already inside the frame untouched", () => {
    const r = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(clampRegion(r)).toEqual(r);
  });

  it("never returns a region larger than the frame", () => {
    const r = clampRegion({ x: 0, y: 0, w: 5, h: 5 });
    expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("regionPixels", () => {
  /*
   * Every dimension must be EVEN. H.264 stores chroma at half resolution, so an
   * odd width or offset has no representation in 4:2:0 — encoders either reject
   * the frame or quietly round it, and a silently-shifted crop is worse than a
   * rejected one.
   */
  it("makes every dimension even", () => {
    for (const r of [
      { x: 0.1234, y: 0.4321, w: 0.3333, h: 0.2777 },
      { x: 0.01, y: 0.02, w: 0.97, h: 0.93 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]) {
      const p = regionPixels(r, 1917, 1083); // deliberately odd frame
      for (const v of [p.x, p.y, p.w, p.h]) expect(v % 2).toBe(0);
    }
  });

  it("keeps the region inside the frame after rounding", () => {
    // The case that overflows if the origin is rounded before the size.
    const p = regionPixels({ x: 0.999, y: 0.999, w: 0.5, h: 0.5 }, 1920, 1080);
    expect(p.x + p.w).toBeLessThanOrEqual(1920);
    expect(p.y + p.h).toBeLessThanOrEqual(1080);
  });

  it("resolves a straightforward region exactly", () => {
    expect(regionPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 1920, 1080)).toEqual({
      x: 480,
      y: 540,
      w: 960,
      h: 270,
    });
  });

  it("never produces a zero-sized crop", () => {
    const p = regionPixels({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 1920, 1080);
    expect(p.w).toBeGreaterThanOrEqual(2);
    expect(p.h).toBeGreaterThanOrEqual(2);
  });

  // A tiny frame is where flooring to even can most easily reach zero.
  it("survives a frame barely bigger than the minimum", () => {
    const p = regionPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 4, 4);
    expect(p.w).toBeGreaterThanOrEqual(2);
    expect(p.x + p.w).toBeLessThanOrEqual(4);
  });
});

describe("isWholeFrame", () => {
  // Cropping the whole frame would build the entire WebCodecs pipeline to
  // achieve nothing, and cost a generation of quality doing it.
  it("treats an absent or full region as nothing to crop", () => {
    expect(isWholeFrame(undefined)).toBe(true);
    expect(isWholeFrame({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it("treats a real region as worth cropping", () => {
    expect(isWholeFrame({ x: 0, y: 0, w: 0.5, h: 1 })).toBe(false);
    expect(isWholeFrame({ x: 0.1, y: 0, w: 0.9, h: 1 })).toBe(false);
  });
});
