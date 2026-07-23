import { describe, it, expect } from "vitest";
import { detectFillerCues } from "./fillerWords";
import type { CaptionCue } from "./types";

describe("fillerWords", () => {
  const style = { font: "Inter", size: 24, color: "#fff", align: "center", posY: 0.85 };

  it("finds um/uh cues", () => {
    const cues: CaptionCue[] = [{ id: "1", start: 1, end: 2, text: "um", style }];
    expect(detectFillerCues(cues)).toHaveLength(1);
  });

  it("ignores normal speech", () => {
    const cues: CaptionCue[] = [{ id: "1", start: 1, end: 3, text: "Open the settings panel", style }];
    expect(detectFillerCues(cues)).toHaveLength(0);
  });
});
