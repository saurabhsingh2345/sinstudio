import { describe, it, expect, afterEach } from "vitest";
import { formatElapsed, isFloatingControlsSupported, openFloatingControls } from "./recorderWindow";

describe("formatElapsed", () => {
  it("reads as a stopwatch", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9)).toBe("00:09");
    expect(formatElapsed(65)).toBe("01:05");
    expect(formatElapsed(600)).toBe("10:00");
    expect(formatElapsed(3599)).toBe("59:59");
  });

  it("truncates rather than rounding, so it never shows a second early", () => {
    expect(formatElapsed(9.99)).toBe("00:09");
  });

  /*
   * Elapsed is derived by subtracting a start timestamp, so a clock adjustment
   * can make it negative. This is the one number on the control the user is
   * watching, and "-1:-3" reads as a crash.
   */
  it("never renders a negative time", () => {
    expect(formatElapsed(-5)).toBe("00:00");
    expect(formatElapsed(Number.NEGATIVE_INFINITY)).toBe("00:00");
  });
});

describe("openFloatingControls", () => {
  const original = (globalThis as Record<string, unknown>).documentPictureInPicture;
  afterEach(() => {
    (globalThis as Record<string, unknown>).documentPictureInPicture = original;
  });

  it("reports unsupported where the API is absent", () => {
    (globalThis as Record<string, unknown>).documentPictureInPicture = undefined;
    expect(isFloatingControlsSupported()).toBe(false);
  });

  // The controls are a convenience on top of a recording that works without
  // them. A browser that lacks the API, or a user who denies the window, must
  // never cost someone their take.
  it("returns null instead of throwing when unsupported", async () => {
    (globalThis as Record<string, unknown>).documentPictureInPicture = undefined;
    await expect(
      openFloatingControls({ onPause() {}, onResume() {}, onStop() {} })
    ).resolves.toBeNull();
  });

  it("returns null when the browser refuses the window", async () => {
    (globalThis as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: () => Promise.reject(new Error("requires user gesture")),
    };
    await expect(
      openFloatingControls({ onPause() {}, onResume() {}, onStop() {} })
    ).resolves.toBeNull();
  });
});
