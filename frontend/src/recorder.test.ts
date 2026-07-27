import { afterEach, describe, it, expect, vi } from "vitest";
import {
  AUDIO_MIMES,
  VIDEO_MIMES,
  acquireDisplay,
  extForMime,
  pickMime,
  recordingName,
} from "./recorder";

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

/*
 * The combination that used to hand back a recording with no cursor in it at
 * all: cursor tracking on (so `cursor: "never"` was requested before the picker
 * opened), and then a window or tab picked in the picker — which cannot be
 * mapped to pointer coordinates, so the track that would have let Studio draw a
 * cursor is thrown away. Real cursor removed, drawn cursor unavailable, and
 * nothing said about it until the take was over.
 */
describe("acquireDisplay", () => {
  type Asked = { cursor?: string };

  function harness(
    surface: string,
    opts: { reportsCursor?: boolean; applyWorks?: boolean } = {}
  ) {
    const { reportsCursor = true, applyWorks = false } = opts;
    const asked: Asked[] = [];
    const stopped: boolean[] = [];

    const make = (hideCursor: boolean) => {
      let hidden = hideCursor;
      const track = {
        getSettings: () => ({
          width: 1920,
          height: 1080,
          displaySurface: surface,
          ...(reportsCursor ? { cursor: hidden ? "never" : "always" } : {}),
        }),
        applyConstraints: async (c: { cursor?: string }) => {
          if (!applyWorks) throw new Error("not settable");
          hidden = c.cursor === "never";
        },
        stop: () => stopped.push(true),
      };
      return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    };

    const navigatorStub = {
      mediaDevices: {
        getDisplayMedia: async (c: { video: Asked }) => {
          asked.push({ cursor: c.video.cursor });
          return make(c.video.cursor === "never");
        },
      },
    };
    vi.stubGlobal("navigator", navigatorStub);
    return { asked, stopped };
  }

  afterEach(() => vi.unstubAllGlobals());

  it("asks for one share and keeps the hidden cursor on a whole-monitor capture", async () => {
    const { asked, stopped } = harness("monitor");
    const notices: string[] = [];
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: true }, (m) => notices.push(m));
    expect(asked).toEqual([{ cursor: "never" }]);
    expect(stopped).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it("never touches the cursor when it was not asked to hide it", async () => {
    const { asked } = harness("browser");
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: false });
    expect(asked).toEqual([{ cursor: undefined }]);
  });

  it("reshares without the constraint when a tab is picked and the cursor was removed", async () => {
    const { asked, stopped } = harness("browser");
    const notices: string[] = [];
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: true }, (m) => notices.push(m));
    expect(asked).toEqual([{ cursor: "never" }, { cursor: undefined }]);
    expect(stopped).toHaveLength(1); // the cursorless share is not left running
    expect(notices).toHaveLength(1);
  });

  it("does the same for a window share", async () => {
    const { asked } = harness("window");
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: true });
    expect(asked).toHaveLength(2);
  });

  // Cheapest repair: if the live track will reconsider, the user never sees a
  // second picker.
  it("prefers fixing the live track over a second picker", async () => {
    const { asked, stopped } = harness("browser", { applyWorks: true });
    const notices: string[] = [];
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: true }, (m) => notices.push(m));
    expect(asked).toEqual([{ cursor: "never" }]);
    expect(stopped).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  // Same policy as cursorIsHidden: a browser that will not say is treated as
  // not having hidden it, so a suspicion never costs the user a second picker.
  it("keeps the share when the browser won't report the cursor state", async () => {
    const { asked } = harness("browser", { reportsCursor: false });
    await acquireDisplay({ fps: 30, systemAudio: false, hideCursor: true });
    expect(asked).toEqual([{ cursor: "never" }]);
  });
});
