import { describe, it, expect } from "vitest";
import { STYLE_PRESETS, presetById } from "./stylePresets";

describe("stylePresets", () => {
  it("has at least 3 presets", () => {
    expect(STYLE_PRESETS.length).toBeGreaterThanOrEqual(3);
  });

  it("each preset has id, name, swatch", () => {
    for (const p of STYLE_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.swatch).toBeTruthy();
    }
  });

  it("presetById finds product-demo", () => {
    const p = presetById("product-demo");
    expect(p?.name).toBe("Product demo");
    expect(p?.backdrop?.color1).toBe("#4f46e5");
  });
});
