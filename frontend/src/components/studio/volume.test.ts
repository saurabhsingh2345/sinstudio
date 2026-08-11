import { describe, expect, it } from "vitest";
import { volumePatch } from "./bridge";
import type { Clip } from "../../types";

const clip = (p: Partial<Clip> = {}): Clip =>
  ({
    id: "c1",
    assetId: "a",
    start: 0,
    in: 0,
    out: 5,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    volume: 1,
    ...p,
  }) as Clip;

describe("volumePatch", () => {
  it("writes the gain straight through", () => {
    expect(volumePatch(clip(), 0.4)).toEqual({ volume: 0.4 });
  });

  it("spells silence with mute, because the export reads volume 0 as unset", () => {
    expect(volumePatch(clip(), 0)).toEqual({ volume: 0, mute: true });
  });

  it("lifts a mute it set itself", () => {
    expect(volumePatch(clip({ volume: 0, mute: true }), 0.6)).toEqual({ volume: 0.6, mute: false });
  });

  /**
   * Detaching a video clip's audio to its own lane mutes the source so the export
   * doesn't play it twice. That clip still has a real volume, so raising its
   * fader must not un-mute it and double the dialogue.
   */
  it("leaves a detach-mute alone", () => {
    expect(volumePatch(clip({ volume: 1, mute: true }), 0.8)).toEqual({ volume: 0.8 });
  });

  it("clamps a negative gain to silence", () => {
    expect(volumePatch(clip(), -0.2)).toEqual({ volume: 0, mute: true });
  });

  it("passes boost above unity through untouched", () => {
    expect(volumePatch(clip(), 1.75)).toEqual({ volume: 1.75 });
  });
});
