import { describe, it, expect } from "vitest";
import { watermarkLayout, watermarkOpacity } from "./watermark";

// Twins with render's TestWatermarkLayoutGolden.
describe("watermarkLayout golden", () => {
  it("defaults tuck a 2:1 logo into the bottom-right", () => {
    expect(watermarkLayout({ assetId: "a" }, 200, 100, 1920, 1080)).toEqual({ x: 1658, y: 934, w: 230, h: 114 });
  });

  it("corners are symmetric", () => {
    const tl = watermarkLayout({ assetId: "a", corner: "tl" }, 200, 100, 1920, 1080);
    const br = watermarkLayout({ assetId: "a", corner: "br" }, 200, 100, 1920, 1080);
    expect(tl.x).toBe(32);
    expect(tl.y).toBe(32);
    expect(br.x + br.w + 32).toBe(1920);
    expect(br.y + br.h + 32).toBe(1080);
  });

  it("unknown image dims fall back to square rather than nothing", () => {
    const g = watermarkLayout({ assetId: "a" }, 0, 0, 1920, 1080);
    expect(g.w).toBe(g.h);
  });

  it("opacity defaults and clamps", () => {
    expect(watermarkOpacity({ assetId: "a" })).toBe(0.6);
    expect(watermarkOpacity({ assetId: "a", opacity: 2 })).toBe(1);
  });
});
