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
    expect(r!.patch.cursor?.clicks).toBeDefined();
    // The amber highlight disc is deliberately NOT automatic: it glows over the
    // content on every frame, which reads as a smudge trailing the cursor.
    expect(r!.patch.cursor?.highlight).toBeUndefined();
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

  it("omits click rings when showClicks is false", () => {
    const r = autoFrame(screen, {}, clickTrack(), 12, canvas, undefined, false);
    expect(r!.patch.cursor?.clicks).toBeUndefined();
  });
});

/*
The guarantee the letterbox default rests on.

FitAuto used to fill on any clip the camera was working, because a push-in on a
letterboxed picture would otherwise slide the transparent bar into frame. It now
letterboxes, and what keeps the bar out is that the camera's viewport is the
PICTURE rather than the canvas — so every offset the framer emits is inside the
content rectangle.

A 4:3 recording in a 16:9 canvas is the case: fitted, the picture is 1440 of
1920 wide, so at scale s the camera may move (1440s - 1920)/2 either way and no
further. Driven by CLICKS rather than dwells, because a click is the event that
reliably produces a zoom — a synthetic dwell track that produces none makes this
test pass without asserting anything, which the first version of it did.
*/
describe("auto-framing a letterboxed recording", () => {
  const canvas = { width: 1920, height: 1080 };
  // Clicks hard against the right edge of the recording, which is exactly where
  // a camera clamped to the canvas rather than to the picture overshoots.
  const track = () =>
    ({
      version: 1,
      video: { width: 1200, height: 900 },
      clicks: true,
      hidden: true,
      samples: [
        { t: 0, x: 600, y: 450 },
        { t: 2000, x: 1150, y: 500 },
        { t: 2100, x: 1150, y: 500, down: 1 },
        { t: 2200, x: 1150, y: 500 },
        { t: 5000, x: 1160, y: 520 },
        { t: 5100, x: 1160, y: 520, down: 1 },
        { t: 5200, x: 1160, y: 520 },
        { t: 8000, x: 1160, y: 520 },
      ],
    }) as never;

  const framed = (fit: string) =>
    autoFrame({ hasCursor: true, cursorHidden: true }, { keyframes: undefined, fit } as never, track(), 8, canvas)
      ?.patch;

  it("never pans further than the picture can cover", () => {
    const kf = framed("")?.keyframes;
    // If no zoom was found the test asserts nothing — say so rather than pass.
    expect(kf?.scale?.length ?? 0).toBeGreaterThan(0);
    expect(kf?.x?.length ?? 0).toBeGreaterThan(0);

    for (const k of kf!.x!) {
      const scale = Math.max(1, ...(kf!.scale ?? []).filter((s) => s.t <= k.t).map((s) => s.value));
      // The fitted picture is as tall as the canvas and 4:3, then zoomed.
      const pictureW = canvas.height * (1200 / 900) * scale;
      const limit = Math.max(0, (pictureW - canvas.width) / 2);
      expect(Math.abs(k.value)).toBeLessThanOrEqual(limit + 1);
    }
  });

  /*
   * A filled clip keeps the wider limit, so the change did not simply make every
   * camera timid.
   *
   * The letterboxed reach here is ZERO, and that is correct rather than broken:
   * fitted, this 4:3 picture is 1440 wide, and at the 1.26 push-in it reaches
   * 1814 — still narrower than the 1920 frame. There is no offset that does not
   * expose more bar on one side, so the camera stays centred. The way to get a
   * following camera on a mismatched recording is to stop it being mismatched,
   * which is what the canvas offer is for.
   */
  it("still uses the whole canvas on a filled clip", () => {
    const reach = (fit: string) =>
      Math.max(0, ...(framed(fit)?.keyframes?.x ?? []).map((k) => Math.abs(k.value)));
    expect(reach("fill")).toBeGreaterThan(0);
    expect(reach("")).toBe(0);
  });
});
