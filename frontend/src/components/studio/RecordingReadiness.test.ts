import { describe, it, expect } from "vitest";
import { buildRecordingReadiness } from "./RecordingReadiness";

describe("buildRecordingReadiness", () => {
  const baseOpts = { screen: true, camera: false, mic: true, systemAudio: false, fps: 30 };

  it("includes screen capture as ok", () => {
    const items = buildRecordingReadiness(baseOpts, null, false, true, true);
    expect(items.some((i) => i.label === "Screen capture" && i.status === "ok")).toBe(true);
  });

  it("warns when region requested but unsupported", () => {
    const items = buildRecordingReadiness(baseOpts, null, true, false, false);
    const region = items.find((i) => i.label === "Region crop");
    expect(region?.status).toBe("warn");
  });

  it("shows cursord ok when helper is running", () => {
    const items = buildRecordingReadiness(baseOpts, {
      ok: true,
      platform: "darwin",
      supported: true,
      clicks: true,
      screen: { width: 1920, height: 1080 },
    }, false, true, true);
    expect(items.find((i) => i.label === "Cursor helper")?.status).toBe("ok");
  });

  it("warns when cursor tracking wanted but cursord absent", () => {
    const items = buildRecordingReadiness(baseOpts, null, false, true, true);
    expect(items.find((i) => i.label === "Cursor helper")?.status).toBe("warn");
  });

  // The note has to say what the take LOSES. Phrased as an instruction to run
  // something, it reads as an optional extra and gets skipped — and the way you
  // then discover it mattered is by finishing a recording that never zooms.
  it("says what a missing helper costs, not just what to run", () => {
    const items = buildRecordingReadiness(baseOpts, null, false, true, true);
    const detail = items.find((i) => i.label === "Cursor helper")!.detail;
    expect(detail).toMatch(/auto-zoom/i);
    expect(detail).toMatch(/click rings|cursor effects/i);
  });
});
