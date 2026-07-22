import { describe, it, expect } from "vitest";
import { BACKDROP_DEFAULTS, backdropCSS, backdropLayout } from "./backdrop";

// These numbers are the contract with render/backdrop.go —
// TestBackdropLayoutGolden asserts the identical values from the Go
// implementation, so either side drifting fails a test rather than quietly
// letting the preview frame a different rectangle than the export fills.
describe("backdropLayout golden", () => {
  it("defaults on a matching 16:9 source", () => {
    expect(backdropLayout({}, 1920, 1080, 1920, 1080)).toEqual({ x: 116, y: 64, w: 1688, h: 950, radius: 14 });
  });

  it("a 4:3 source keeps its shape inside the inset box", () => {
    expect(backdropLayout({}, 1440, 1080, 1920, 1080)).toEqual({ x: 326, y: 64, w: 1266, h: 950, radius: 14 });
  });

  it("explicit inset and radius, radius scaled to the canvas height", () => {
    const g = backdropLayout({ inset: 0.2, radius: 40 }, 1920, 1080, 1280, 720);
    expect(g.x).toBe(256);
    expect(g.y).toBe(144);
    expect(g.w).toBe(768);
    expect(g.h).toBe(432);
    expect(g.radius).toBeCloseTo(26.666666, 4);
  });

  it("unknown source dims lay out as canvas-shaped", () => {
    expect(backdropLayout({}, 0, 0, 1920, 1080)).toEqual(backdropLayout({}, 1920, 1080, 1920, 1080));
  });

  it("every dimension is even — 4:2:0 refuses odd sizes", () => {
    for (const [vw, vh] of [[1919, 1077], [997, 601], [1280, 719]] as const) {
      const g = backdropLayout({}, vw, vh, 1920, 1080);
      expect(g.w % 2).toBe(0);
      expect(g.h % 2).toBe(0);
      expect(g.x % 2).toBe(0);
      expect(g.y % 2).toBe(0);
    }
  });

  it("inset is capped so the picture cannot vanish", () => {
    const g = backdropLayout({ inset: 0.49 }, 1920, 1080, 1920, 1080);
    expect(g.w).toBeGreaterThanOrEqual(1920 * (1 - 2 * BACKDROP_DEFAULTS.maxInset) - 2);
  });
});

describe("backdropCSS", () => {
  it("is a flat colour without color2, a gradient with it", () => {
    expect(backdropCSS({ color1: "#112233" })).toBe("#112233");
    expect(backdropCSS({ color1: "#112233", color2: "#445566" })).toBe("linear-gradient(180deg, #112233, #445566)");
  });
});
