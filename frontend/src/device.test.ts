import { describe, it, expect } from "vitest";
import { deviceBox, deviceLayout, deviceSpec, DEVICE_KINDS } from "./device";

describe("deviceLayout", () => {
  /*
   * The SAME numbers are produced by deviceLayout() in
   * backend/internal/render/device.go. The export pads the recording into this
   * rectangle and the preview insets a <video> into it; if they drift, the
   * preview puts the picture where the render does not. Unlike a colour
   * approximation that is a lie about geometry, which the preview never gets to
   * tell.
   */
  it("agrees with the Go renderer, to the pixel", () => {
    expect(deviceLayout("browser", 1920, 1080)).toEqual({ x: 150, y: 114, w: 1618, h: 906 });
    expect(deviceLayout("phone", 1920, 1080)).toEqual({ x: 732, y: 52, w: 454, h: 972 });
    expect(deviceLayout("tablet", 1920, 1080)).toEqual({ x: 620, y: 74, w: 676, h: 928 });
    expect(deviceLayout("laptop", 1920, 1080)).toEqual({ x: 282, y: 68, w: 1352, h: 786 });
  });

  // A portrait canvas binds on the other axis, which is the case most likely to
  // be got wrong by fitting on one dimension only.
  it("agrees with the renderer on a portrait canvas too", () => {
    expect(deviceLayout("phone", 1080, 1920)).toEqual({ x: 134, y: 94, w: 808, h: 1728 });
  });

  it("keeps every screen inside the canvas", () => {
    for (const { kind } of DEVICE_KINDS) {
      for (const [cw, ch] of [
        [1920, 1080],
        [1080, 1920],
        [1080, 1080],
        [640, 360],
      ]) {
        const g = deviceLayout(kind, cw, ch);
        expect(g.x).toBeGreaterThanOrEqual(0);
        expect(g.y).toBeGreaterThanOrEqual(0);
        expect(g.x + g.w).toBeLessThanOrEqual(cw);
        expect(g.y + g.h).toBeLessThanOrEqual(ch);
      }
    }
  });

  // Matches the renderer's even() for the same 4:2:0 reason.
  it("gives even dimensions even on an odd canvas", () => {
    for (const { kind } of DEVICE_KINDS) {
      const g = deviceLayout(kind, 1917, 1083);
      for (const v of [g.x, g.y, g.w, g.h]) expect(v % 2).toBe(0);
    }
  });

  it("falls back to a renderable frame for an unknown kind", () => {
    expect(deviceSpec("teapot")).toEqual(deviceSpec("browser"));
    const g = deviceLayout("teapot", 1920, 1080);
    expect(g.w).toBeGreaterThan(2);
  });
});

describe("deviceBox", () => {
  it("centres the device and leaves a margin", () => {
    const b = deviceBox("browser", 1920, 1080);
    expect(b.x).toBeGreaterThan(0);
    expect(b.x * 2 + b.w).toBeCloseTo(1920, 6);
    expect(b.y * 2 + b.h).toBeCloseTo(1080, 6);
  });

  it("keeps each device's own proportions", () => {
    for (const { kind } of DEVICE_KINDS) {
      const b = deviceBox(kind, 1920, 1080);
      expect(b.w / b.h).toBeCloseTo(deviceSpec(kind).aspect, 6);
    }
  });
});
