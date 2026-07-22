import { describe, it, expect } from "vitest";
import {
  CHROMA_BLEND,
  CHROMA_COLOR,
  CHROMA_SIMILARITY,
  hexToRGB,
  keyAlpha,
  newChroma,
  resolveChroma,
  rgbToHex,
  toUV,
} from "./chroma";

describe("resolveChroma", () => {
  // The renderer cannot tell an omitted JSON field from a zero one, so it reads
  // 0 as "unset". The preview has to agree or a freshly-created key would look
  // inert in one half and working in the other.
  it("treats zero as unset the way the renderer does", () => {
    const c = resolveChroma({ similarity: 0, blend: 0 });
    expect(c.similarity).toBe(CHROMA_SIMILARITY);
    expect(c.blend).toBe(CHROMA_BLEND);
    expect(c.color).toBe(CHROMA_COLOR);
  });

  it("keeps values that were actually chosen", () => {
    expect(resolveChroma({ similarity: 0.6, blend: 0.2, color: "#00ff00", spill: 0.4 })).toEqual({
      similarity: 0.6,
      blend: 0.2,
      color: "#00ff00",
      spill: 0.4,
    });
  });

  it("starts a new key from the colour a real screen is", () => {
    expect(newChroma().color).toBe(CHROMA_COLOR);
    expect(resolveChroma(newChroma()).similarity).toBeGreaterThan(0);
  });
});

describe("hex conversion", () => {
  it("round-trips a colour", () => {
    const [r, g, b] = hexToRGB("#00b140");
    expect(rgbToHex(r * 255, g * 255, b * 255)).toBe("#00b140");
  });

  it("accepts a hex with or without the hash", () => {
    expect(hexToRGB("00b140")).toEqual(hexToRGB("#00b140"));
  });

  // An unparseable colour must not produce NaN uniforms, which render as a
  // black frame rather than as an obviously wrong colour.
  it("falls back to chroma green rather than NaN", () => {
    for (const bad of ["", "not a colour", "#xyzxyz", "#fff"]) {
      const rgb = hexToRGB(bad);
      expect(rgb.every((v) => Number.isFinite(v))).toBe(true);
      expect(rgb).toEqual(hexToRGB(CHROMA_COLOR));
    }
  });

  it("clamps out-of-range channels instead of emitting bad hex", () => {
    expect(rgbToHex(-20, 300, 128)).toBe("#00ff80");
  });
});

describe("toUV", () => {
  /*
   * Working in chroma REDUCES sensitivity to uneven lighting; it does not
   * eliminate it. U and V still scale with intensity, so a dim green and a
   * bright green are not identical — they are simply much closer together than
   * in RGB, which is what lets one threshold cover a screen that is brighter
   * under the lamps than it is in the corners. ffmpeg's `chromakey` has exactly
   * the same property, which is why the two halves agree.
   *
   * Stated as a ratio rather than an absolute, because the absolute is what
   * misled the first version of this test into claiming invariance.
   */
  it("is markedly less sensitive to brightness than RGB distance is", () => {
    const [br, bg, bb] = hexToRGB("#00ff00");
    const [dr, dg, db] = hexToRGB("#007a00");
    const rgbDist = Math.hypot(br - dr, bg - dg, bb - db);
    const [bu, bv] = toUV(br, bg, bb);
    const [du, dv] = toUV(dr, dg, db);
    const uvDist = Math.hypot(bu - du, bv - dv);
    expect(uvDist).toBeLessThan(rgbDist * 0.6);
  });

  it("separates colours that differ in hue", () => {
    const green = toUV(...hexToRGB("#00b140"));
    const red = toUV(...hexToRGB("#c02020"));
    expect(Math.hypot(green[0] - red[0], green[1] - red[1])).toBeGreaterThan(0.4);
  });
});

describe("keyAlpha", () => {
  const key = hexToRGB(CHROMA_COLOR);

  it("removes the screen colour entirely", () => {
    expect(keyAlpha(key, key, CHROMA_SIMILARITY, CHROMA_BLEND)).toBe(0);
  });

  it("keeps a subject colour fully", () => {
    expect(keyAlpha(hexToRGB("#c02020"), key, CHROMA_SIMILARITY, CHROMA_BLEND)).toBe(1);
  });

  // A screen lit unevenly is still the screen. This is the case a naive RGB
  // distance gets wrong, and the reason for working in UV.
  it("removes an unevenly lit screen at the same threshold", () => {
    for (const shade of ["#00c94a", "#009638", "#00b140"]) {
      expect(keyAlpha(hexToRGB(shade), key, CHROMA_SIMILARITY, CHROMA_BLEND)).toBe(0);
    }
  });

  it("fades gradually across the blend band rather than cutting hard", () => {
    // A colour placed just outside the threshold should be partially kept.
    const a = keyAlpha(hexToRGB("#4a9e5e"), key, 0.05, 0.5);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it("widening the amount removes more", () => {
    const px = hexToRGB("#3f8f55");
    const narrow = keyAlpha(px, key, 0.02, 0.01);
    const wide = keyAlpha(px, key, 0.9, 0.01);
    expect(wide).toBeLessThan(narrow);
  });

  // A zero blend must still be a valid divisor; the shader guards the same way.
  it("survives a zero blend", () => {
    expect(Number.isFinite(keyAlpha(hexToRGB("#ffffff"), key, 0.2, 0))).toBe(true);
    expect(keyAlpha(hexToRGB("#ffffff"), key, 0.2, 0)).toBe(1);
  });
});
