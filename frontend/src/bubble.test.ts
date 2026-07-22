import { describe, it, expect } from "vitest";
import { bubbleCorner, bubbleLayout } from "./bubble";

// Twins with render's TestBubbleLayoutGolden — identical numbers from both
// implementations, or the preview frames a different circle than the export.
describe("bubbleLayout golden", () => {
  it("defaults on a 1920x1080 canvas", () => {
    expect(bubbleLayout({}, 1920, 1080)).toEqual({ d: 302, x: 808, y: 388, radius: 151, border: 6 });
  });

  it("rounded card and a smaller canvas", () => {
    const g = bubbleLayout({ shape: "rounded" }, 1280, 720);
    expect(g.d).toBe(200);
    expect(g.x).toBe(540);
    expect(g.y).toBe(260);
    expect(g.radius).toBeCloseTo(36, 9);
    expect(g.border).toBeCloseTo(4, 9);
  });

  it("negative border means none", () => {
    expect(bubbleLayout({ border: -1 }, 1920, 1080).border).toBe(0);
  });

  it("size is clamped to something visible", () => {
    expect(bubbleLayout({ size: 5 }, 1920, 1080).d).toBeLessThanOrEqual(1080 * 0.9);
  });
});

describe("bubbleCorner", () => {
  it("corner offsets are symmetric and margined", () => {
    const g = bubbleLayout({}, 1920, 1080);
    const br = bubbleCorner("br", g, 1920, 1080);
    const tl = bubbleCorner("tl", g, 1920, 1080);
    expect(br.x).toBe(-tl.x);
    expect(br.y).toBe(-tl.y);
    // Bubble right edge = centre + d/2 + x offset; must clear the canvas edge
    // by the margin.
    expect(1920 / 2 + g.d / 2 + br.x).toBeLessThan(1920);
    expect(bubbleCorner("center", g, 1920, 1080)).toEqual({ x: 0, y: 0 });
  });
});
