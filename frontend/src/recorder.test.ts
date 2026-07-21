import { describe, it, expect } from "vitest";
import { AUDIO_MIMES, VIDEO_MIMES, extForMime, pickMime, recordingName } from "./recorder";

describe("pickMime", () => {
  it("takes the first supported candidate, in preference order", () => {
    const only = (want: string) => (m: string) => m === want;
    expect(pickMime(VIDEO_MIMES, only("video/webm;codecs=vp8,opus"))).toBe("video/webm;codecs=vp8,opus");
    expect(pickMime(VIDEO_MIMES, () => true)).toBe(VIDEO_MIMES[0]);
  });

  it("prefers mp4 over webm when both are available", () => {
    const supported = (m: string) => m.includes("mp4") || m.includes("webm");
    expect(pickMime(VIDEO_MIMES, supported)).toContain("mp4");
  });

  it("returns empty rather than an unsupported type, so the browser picks", () => {
    expect(pickMime(VIDEO_MIMES, () => false)).toBe("");
  });

  // Safari has historically thrown here instead of returning false.
  it("survives isTypeSupported throwing", () => {
    const throwsOnFirst = (m: string) => {
      if (m === VIDEO_MIMES[0]) throw new TypeError("nope");
      return m === "video/webm";
    };
    expect(pickMime(VIDEO_MIMES, throwsOnFirst)).toBe("video/webm");
  });
});

describe("extForMime", () => {
  it("maps container to extension, and audio-only to an audio container", () => {
    expect(extForMime("video/mp4;codecs=avc1", "screen")).toBe(".mp4");
    expect(extForMime("video/webm;codecs=vp9,opus", "screen")).toBe(".webm");
    expect(extForMime("audio/webm;codecs=opus", "mic")).toBe(".webm");
    expect(extForMime("audio/mp4", "mic")).toBe(".m4a");
  });

  it("falls back to webm for an unrecognised type rather than guessing", () => {
    expect(extForMime("application/octet-stream", "camera")).toBe(".webm");
    expect(extForMime("", "screen")).toBe(".webm");
  });
});

describe("recordingName", () => {
  it("is sortable, and says what it is", () => {
    const at = new Date(2026, 6, 21, 9, 5, 3); // local time, as the user sees it
    expect(recordingName("screen", at, ".webm")).toBe("screen-20260721-090503.webm");
    expect(recordingName("mic", at, ".m4a")).toBe("mic-20260721-090503.m4a");
  });

  it("zero-pads so names sort lexicographically in the library", () => {
    const early = recordingName("screen", new Date(2026, 0, 2, 3, 4, 5), ".webm");
    const later = recordingName("screen", new Date(2026, 10, 20, 13, 14, 15), ".webm");
    expect(early < later).toBe(true);
    expect(early).toBe("screen-20260102-030405.webm");
  });
});

describe("audio candidates", () => {
  it("offers opus first — every target browser has it and it's the best fit for speech", () => {
    expect(AUDIO_MIMES[0]).toContain("opus");
  });
});
