import { describe, it, expect } from "vitest";
import { checklistItems, type PostRecordSummary } from "./PostRecordChecklist";

const base: PostRecordSummary = { trackCount: 2, autoZoomClips: 3, hadCursor: true };

describe("checklistItems", () => {
  it("says what happened to the recording", () => {
    const text = checklistItems(base).map((i) => i.text).join(" | ");
    expect(text).toContain("2 tracks placed");
    expect(text).toContain("Auto-zoom on 3 clips");
  });

  it("distinguishes a tracked cursor that produced no zooms from no cursor at all", () => {
    const none = checklistItems({ ...base, autoZoomClips: 0 });
    expect(none.find((i) => i.text.includes("Cursor tracked"))?.done).toBe(false);
    const noCursor = checklistItems({ ...base, hadCursor: false });
    expect(noCursor.some((i) => i.text.includes("Cursor"))).toBe(false);
  });

  /*
   * The line that matters. Recording a window into a project that started as a
   * whole screen lands it in a frame it does not fit — it used to be cropped
   * away silently, and now it letterboxes. Without this line someone is left
   * looking at bars with nothing to tell them what put them there.
   */
  it("warns when the recording is a different shape from the project", () => {
    const items = checklistItems({
      ...base,
      shapeMismatch: { width: 1280, height: 960, onMatch: () => {} },
    });
    expect(items.some((i) => i.text.includes("different shape"))).toBe(true);
  });

  it("says nothing about shape when the recording fits", () => {
    expect(checklistItems(base).some((i) => i.text.includes("different shape"))).toBe(false);
  });
});
