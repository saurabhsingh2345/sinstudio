import { describe, it, expect } from "vitest";
import { luma, lumaHistogram, solidFromBackground } from "./lumaHistogram";

describe("lumaHistogram", () => {
  it("computes luma for black and white", () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(255, 255, 255)).toBeCloseTo(255, 0);
  });

  it("bins pixel values", () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]);
    const bins = lumaHistogram(data);
    expect(bins[0]).toBe(1);
    expect(bins[255]).toBe(1);
  });

  it("extracts first hex from gradient css", () => {
    expect(solidFromBackground("linear-gradient(180deg, #111, #222)")).toBe("#111");
    expect(solidFromBackground("#abc")).toBe("#abc");
  });
});
