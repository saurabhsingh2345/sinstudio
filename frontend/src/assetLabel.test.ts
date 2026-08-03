import { describe, it, expect } from "vitest";
import { assetLabel } from "./types";

describe("assetLabel", () => {
  /*
   * The generic ingest path names a file source + stamp + filename, and the
   * recorder's filename already carries the kind and a timestamp — so a screen
   * capture lands with both written twice, stretched across the clip bar.
   */
  it("gives a recording a human name instead of its mangled filename", () => {
    expect(
      assetLabel({
        name: "recording-screen-20260722-045414-screen-20260722-102409.mp4",
        source: "recording-screen",
      })
    ).toBe("Screen recording");
  });

  it("names each recorded source", () => {
    expect(assetLabel({ name: "x.webm", source: "recording-camera" })).toBe("Camera");
    expect(assetLabel({ name: "x.webm", source: "recording-mic" })).toBe("Microphone");
  });

  // A generated or imported asset's name was chosen by someone; keep it.
  it("keeps a real name, without the extension", () => {
    expect(assetLabel({ name: "intro-bumper.mp4", source: "funkycode" })).toBe("intro-bumper");
    expect(assetLabel({ name: "My Clip.mov", source: "" })).toBe("My Clip");
  });

  it("never returns an empty label", () => {
    expect(assetLabel({ name: "", source: "" })).toBe("Clip");
    expect(assetLabel({ name: ".mp4", source: "" })).toBe("Clip");
  });

  // A source that merely looks recording-ish must not be mistaken for one.
  it("does not claim unrelated sources", () => {
    expect(assetLabel({ name: "a.mp4", source: "recording-screenshare" })).toBe("a");
  });

  /*
   * The derived names above are all fallbacks for a name nobody chose. Once
   * someone renames an asset, showing "Screen recording" anyway makes the rename
   * look broken — the field accepted the text and the list ignored it.
   */
  it("prefers a typed label over every derived name", () => {
    expect(
      assetLabel({
        name: "recording-screen-20260722-045414.mp4",
        source: "recording-screen",
        label: "Chrome — checkout flow",
      })
    ).toBe("Chrome — checkout flow");
    expect(assetLabel({ name: "intro-bumper.mp4", source: "funkycode", label: "Bumper" })).toBe("Bumper");
  });

  // A label is kept verbatim: it is not a filename, so it keeps its spaces and
  // anything that merely looks like an extension.
  it("keeps a label verbatim", () => {
    expect(assetLabel({ name: "x.mp4", source: "", label: "  v2.final  " })).toBe("v2.final");
  });

  // A blank label is not a rename — fall through rather than showing nothing.
  it("ignores an empty label", () => {
    expect(assetLabel({ name: "x.webm", source: "recording-mic", label: "   " })).toBe("Microphone");
  });
});
