import { describe, expect, it } from "vitest";
import { alreadyMatches, barsAgainst, canvasForClip, MAX_CANVAS_EDGE } from "./matchCanvas";

const asset = (width: number, height: number) => ({ width, height });

describe("canvasForClip", () => {
  it("is the clip's own size when nothing is cropped", () => {
    expect(canvasForClip(asset(1512, 982), {}, 30)).toEqual({ width: 1512, height: 982, fps: 30 });
  });

  it("measures the CROPPED picture, not the source", () => {
    // Trim 10% off each side: 1920*0.8 = 1536 wide, height untouched.
    const c = canvasForClip(asset(1920, 1080), { crop: { left: 0.1, right: 0.1 } }, 30);
    expect(c).toEqual({ width: 1536, height: 1080, fps: 30 });
  });

  it("forces even dimensions", () => {
    const c = canvasForClip(asset(1001, 777), {}, 30)!;
    expect(c.width % 2).toBe(0);
    expect(c.height % 2).toBe(0);
  });

  it("caps the long edge but keeps the shape", () => {
    const c = canvasForClip(asset(7680, 4320), {}, 60)!;
    expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(MAX_CANVAS_EDGE);
    expect(c.width / c.height).toBeCloseTo(16 / 9, 2);
  });

  it("stays unknown rather than guessing", () => {
    expect(canvasForClip(undefined, {}, 30)).toBeNull();
    expect(canvasForClip(asset(0, 0), {}, 30)).toBeNull();
  });

  it("keeps a sane fps when the canvas has none", () => {
    expect(canvasForClip(asset(100, 100), {}, 0)!.fps).toBe(30);
  });

  it("produces a canvas the clip does not bar against", () => {
    const src = asset(1512, 982);
    const c = canvasForClip(src, {}, 30)!;
    expect(barsAgainst(src, {}, c)).toBe("none");
  });
});

describe("barsAgainst", () => {
  const canvas = { width: 1920, height: 1080 };

  it("names sides when the picture is narrower than the frame", () => {
    expect(barsAgainst(asset(1512, 982), {}, canvas)).toBe("sides"); // 1.54 < 1.78
    expect(barsAgainst(asset(1080, 1920), {}, canvas)).toBe("sides");
  });

  it("names top and bottom when the picture is wider", () => {
    expect(barsAgainst(asset(2560, 1080), {}, canvas)).toBe("topAndBottom");
  });

  it("is none for a matching shape, at any size", () => {
    expect(barsAgainst(asset(1280, 720), {}, canvas)).toBe("none");
    expect(barsAgainst(asset(3840, 2160), {}, canvas)).toBe("none");
  });

  it("accounts for the crop", () => {
    // 16:9 source cropped to a square is no longer 16:9.
    const crop = { left: 0.219, right: 0.219 };
    expect(barsAgainst(asset(1920, 1080), { crop }, canvas)).toBe("sides");
  });

  it("is none when anything is unknown", () => {
    expect(barsAgainst(undefined, {}, canvas)).toBe("none");
    expect(barsAgainst(asset(100, 100), {}, undefined)).toBe("none");
  });
});

describe("alreadyMatches", () => {
  it("agrees with barsAgainst", () => {
    expect(alreadyMatches(asset(1920, 1080), {}, { width: 1280, height: 720 })).toBe(true);
    expect(alreadyMatches(asset(1512, 982), {}, { width: 1920, height: 1080 })).toBe(false);
  });
});
