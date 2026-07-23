import { describe, it, expect } from "vitest";
import { applyCaptionPresetStyle, CAPTION_PRESETS } from "./captionPresets";
import type { CaptionStyle } from "./types";

describe("captionPresets", () => {
  const base: CaptionStyle = {
    font: "Inter",
    size: 24,
    color: "#ffffff",
    align: "center",
    posY: 0.85,
  };

  it("merges preset fields onto existing style", () => {
    const preset = CAPTION_PRESETS.find((p) => p.id === "boxed")!;
    const merged = applyCaptionPresetStyle(base, preset);
    expect(merged.background).toBe("rgba(0,0,0,0.65)");
    expect(merged.size).toBe(26);
    expect(merged.font).toBe("Inter");
  });

  it("has five presets", () => {
    expect(CAPTION_PRESETS.length).toBe(5);
  });
});
