import { describe, it, expect } from "vitest";
import { detectChapters, chaptersToYouTube } from "./chapterMarkers";
import type { CaptionCue } from "./types";

describe("chapterMarkers", () => {
  const style = { font: "Inter", size: 24, color: "#fff", align: "center", posY: 0.85 };
  const cues: CaptionCue[] = [
    { id: "1", start: 0, end: 2, text: "Welcome to the demo", style },
    { id: "2", start: 10, end: 12, text: "Next we open settings", style },
  ];

  it("detects caption gap chapters", () => {
    const chapters = detectChapters([], cues, { minCaptionGap: 3 });
    expect(chapters.some((c) => c.label.includes("Next"))).toBe(true);
    expect(chapters.find((c) => c.t === 10)?.label).toContain("Next");
  });

  it("formats YouTube chapters", () => {
    const text = chaptersToYouTube([
      { t: 0, label: "Intro", source: "caption" },
      { t: 65, label: "Setup", source: "pause" },
    ]);
    expect(text).toContain("0:00 Intro");
    expect(text).toContain("1:05 Setup");
  });
});
