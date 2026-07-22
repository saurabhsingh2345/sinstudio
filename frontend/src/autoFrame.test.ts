import { describe, it, expect } from "vitest";
import { autoFrame } from "./autoFrame";
import { SMART_FOCUS_DEFAULTS } from "./smartFocus";

/*
The ingest path, tested.

This logic used to live inside the record panel's async callback, where it could
only be exercised by granting a real screen share — which meant it shipped
unverified. The point of pulling it out is that these run in a second.
*/

const canvas = { width: 1920, height: 1080 };

/** A pointer track with real presses, the way a session with clicks looks. */
const clickTrack = () => {
  const samples: { t: number; x: number; y: number; down?: number }[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = i * 100; // 12s at 10Hz
    // Parked at one spot, then another, with a press in each.
    const at = t < 6000 ? { x: 500, y: 400 } : { x: 1400, y: 800 };
    const down = t === 2000 || t === 8000 ? 1 : undefined;
    samples.push({ t, ...at, ...(down ? { down } : {}) });
  }
  return { samples, video: { width: 1920, height: 1080 } };
};

const screen = { hasCursor: true, cursorHidden: false };

describe("autoFrame", () => {
  it("frames a screen recording that has a pointer track", () => {
    const r = autoFrame(screen, {}, clickTrack(), 12, canvas);
    expect(r).not.toBeNull();
    expect(r!.zooms).toBeGreaterThan(0);
    expect(r!.patch.keyframes?.scale?.length).toBeGreaterThan(1);
  });

  // Most imports are not screen recordings. Inventing camera moves for a clip
  // that never had a pointer would be worse than leaving it alone.
  it("leaves anything without cursor data completely alone", () => {
    expect(autoFrame({ hasCursor: false }, {}, clickTrack(), 12, canvas)).toBeNull();
    expect(autoFrame(screen, {}, null, 12, canvas)).toBeNull();
    expect(autoFrame(screen, {}, { samples: [], video: canvas }, 12, canvas)).toBeNull();
  });

  it("refuses a zero-length clip rather than dividing by it", () => {
    expect(autoFrame(screen, {}, clickTrack(), 0, canvas)).toBeNull();
  });

  /*
   * Cursor emphasis is applied even when no zoom was found.
   *
   * A short clip, or one with no clear focus, still wants its clicks visible —
   * and this is the case that would otherwise land completely unstyled, which
   * is the exact "nothing happened" the whole change exists to fix.
   */
  it("still adds cursor effects when there is nothing to zoom on", () => {
    // A pointer that never stops moving and never clicks: no focus segments.
    const wandering = {
      samples: Array.from({ length: 40 }, (_, i) => ({ t: i * 100, x: i * 40, y: i * 20 })),
      video: { width: 1920, height: 1080 },
    };
    const r = autoFrame(screen, {}, wandering, 4, canvas);
    expect(r).not.toBeNull();
    expect(r!.zooms).toBe(0);
    expect(r!.patch.cursor?.highlight).toBeDefined();
    expect(r!.patch.cursor?.clicks).toBeDefined();
    // No zooms means no keyframes written — the clip is not silently animated.
    expect(r!.patch.keyframes).toBeUndefined();
  });

  /*
   * Studio only draws its own pointer when the real one was verifiably kept out
   * of the capture. Drawing a second cursor over a burned-in one is worse than
   * drawing none, and this is the flag that decides it.
   */
  it("only draws its own pointer when the real one was excluded", () => {
    expect(autoFrame({ hasCursor: true, cursorHidden: false }, {}, clickTrack(), 12, canvas)!.patch.cursor?.pointer)
      .toBeUndefined();
    expect(autoFrame({ hasCursor: true, cursorHidden: true }, {}, clickTrack(), 12, canvas)!.patch.cursor?.pointer)
      .toBeDefined();
  });

  // Framing must not throw away work already on the clip.
  it("keeps keyframes the clip already had", () => {
    const existing = { opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] };
    const r = autoFrame(screen, { keyframes: existing }, clickTrack(), 12, canvas);
    expect(r!.patch.keyframes?.opacity).toEqual(existing.opacity);
    expect(r!.patch.keyframes?.scale).toBeDefined();
  });

  it("aims the zoom where the clicks were, not at frame centre", () => {
    const r = autoFrame(screen, {}, clickTrack(), 12, canvas);
    const xs = r!.patch.keyframes!.x!;
    // Something has to move; an all-zero x track means it zoomed the middle.
    expect(xs.some((k) => k.value !== 0)).toBe(true);
  });

  // The scale track must return to full frame, or the clip ends mid-zoom and
  // the next one cuts in from nowhere.
  it("returns to full frame by the end", () => {
    const r = autoFrame(screen, {}, clickTrack(), 12, canvas);
    const scale = r!.patch.keyframes!.scale!;
    expect(scale[scale.length - 1]!.value).toBeCloseTo(1, 6);
  });

  it("respects options handed to it", () => {
    const noClicks = { ...SMART_FOCUS_DEFAULTS, useClicks: false, useDwell: false };
    const r = autoFrame(screen, {}, clickTrack(), 12, canvas, noClicks);
    expect(r!.zooms).toBe(0);
  });
});
