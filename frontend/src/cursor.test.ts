import { describe, it, expect } from "vitest";
import { canMapToVideo, toSidecar, type CursorRecording } from "./cursor";

const rec = (over: Partial<CursorRecording> = {}): CursorRecording => ({
  version: 1,
  startedAt: 1000,
  stoppedAt: 5000,
  screen: { width: 1728, height: 1080 },
  clicks: true,
  samples: [],
  ...over,
});

describe("canMapToVideo", () => {
  // Pointer coordinates are whole-screen. They only land correctly on a video
  // that IS the whole screen; a window share has an unknown origin, and
  // guessing would misplace every highlight rather than failing visibly.
  it("only accepts a whole-monitor capture", () => {
    expect(canMapToVideo("monitor")).toBe(true);
    expect(canMapToVideo("window")).toBe(false);
    expect(canMapToVideo("browser")).toBe(false);
    expect(canMapToVideo(undefined)).toBe(false);
  });
});

describe("toSidecar", () => {
  it("rebases timestamps onto the video's first frame", () => {
    const r = rec({
      samples: [
        { t: 1000, x: 0, y: 0 },
        { t: 1500, x: 10, y: 10 },
        { t: 2000, x: 20, y: 20 },
      ],
    });
    const out = toSidecar(r, 1000, { width: 1728, height: 1080 });
    expect(out.samples.map((s) => s.t)).toEqual([0, 500, 1000]);
  });

  // Tracking starts before the recorder so no motion is missed at frame zero,
  // which means early samples legitimately predate the video.
  it("drops samples from before the video started", () => {
    const r = rec({
      samples: [
        { t: 800, x: 1, y: 1 },
        { t: 900, x: 2, y: 2 },
        { t: 1200, x: 3, y: 3 },
      ],
    });
    const out = toSidecar(r, 1000, { width: 1728, height: 1080 });
    expect(out.samples).toHaveLength(1);
    expect(out.samples[0].t).toBe(200);
  });

  it("scales screen coordinates into the captured frame", () => {
    const r = rec({
      screen: { width: 1728, height: 1080 },
      samples: [{ t: 1000, x: 864, y: 540 }], // dead centre
    });
    // Captured at 2x (a Retina display grabbed at native pixels).
    const out = toSidecar(r, 1000, { width: 3456, height: 2160 });
    expect(out.samples[0]).toMatchObject({ x: 1728, y: 1080 });
    expect(out.video).toEqual({ width: 3456, height: 2160 });
  });

  it("scales down for a constrained capture", () => {
    const r = rec({
      screen: { width: 2000, height: 1000 },
      samples: [
        { t: 1000, x: 1000, y: 500 },
        { t: 1100, x: 2000, y: 1000 },
      ],
    });
    const out = toSidecar(r, 1000, { width: 1000, height: 500 });
    expect(out.samples[0]).toMatchObject({ x: 500, y: 250 });
    expect(out.samples[1]).toMatchObject({ x: 1000, y: 500 });
  });

  it("keeps button state and omits it when unpressed", () => {
    const r = rec({
      samples: [
        { t: 1000, x: 5, y: 5 },
        { t: 1100, x: 5, y: 5, down: 1 },
        { t: 1200, x: 5, y: 5, down: 2 },
      ],
    });
    const out = toSidecar(r, 1000, { width: 1728, height: 1080 });
    expect(out.samples[0].down).toBeUndefined();
    expect(out.samples[1].down).toBe(1);
    expect(out.samples[2].down).toBe(2);
  });

  it("carries the clicks flag so 'no clicks' is distinguishable from 'clicks unseen'", () => {
    expect(toSidecar(rec({ clicks: false, samples: [{ t: 1000, x: 0, y: 0 }] }), 1000, { width: 10, height: 10 }).clicks).toBe(false);
    expect(toSidecar(rec({ clicks: true, samples: [{ t: 1000, x: 0, y: 0 }] }), 1000, { width: 10, height: 10 }).clicks).toBe(true);
  });

  // A zero would otherwise produce NaN coordinates and a silently corrupt file.
  it("survives a helper that reported no screen size", () => {
    const r = rec({ screen: { width: 0, height: 0 }, samples: [{ t: 1000, x: 12, y: 34 }] });
    const out = toSidecar(r, 1000, { width: 1920, height: 1080 });
    expect(out.samples[0]).toMatchObject({ x: 12, y: 34 });
    expect(Number.isFinite(out.samples[0].x)).toBe(true);
  });
});

describe("toSidecar with a region recording", () => {
  // cursord reports against the whole screen; a region recording's video is a
  // rectangle inside it. Getting this wrong misplaces every highlight, ring and
  // drawn pointer by the region's offset — consistently, so it looks like a
  // calibration bug rather than a coordinate one.
  const rec = (samples: { t: number; x: number; y: number }[]) => ({
    version: 1,
    startedAt: 0,
    stoppedAt: 1000,
    screen: { width: 1920, height: 1080 },
    samples,
    clicks: true,
  });

  it("shifts samples into the region's own frame", () => {
    const s = toSidecar(rec([{ t: 0, x: 500, y: 400 }]), 0, { width: 640, height: 360 }, false, {
      frame: { width: 1920, height: 1080 },
      x: 400,
      y: 300,
    });
    expect(s.samples[0]).toMatchObject({ x: 100, y: 100 });
    expect(s.video).toEqual({ width: 640, height: 360 });
  });

  /*
   * Scaling must use the WHOLE captured frame, not the region.
   *
   * A Retina screen reported at 1920 but captured at 3840 needs every sample
   * doubled before the region's offset is subtracted. Scaling by the region
   * instead would compound the two errors and put the pointer nowhere near the
   * content it is marking.
   */
  it("scales against the full frame, then offsets by the region", () => {
    const s = toSidecar(rec([{ t: 0, x: 500, y: 400 }]), 0, { width: 640, height: 360 }, false, {
      frame: { width: 3840, height: 2160 }, // 2x the reported screen
      x: 800,
      y: 600,
    });
    // 500 * 2 = 1000, minus the 800 origin.
    expect(s.samples[0]).toMatchObject({ x: 200, y: 200 });
  });

  // A pointer outside the region has no position in the video. Keeping it would
  // place the highlight outside the clip's box — drawn over whatever else is on
  // the canvas, which is worse than not drawing it.
  it("drops samples that fall outside the region", () => {
    const s = toSidecar(
      rec([
        { t: 0, x: 500, y: 400 }, // inside
        { t: 10, x: 100, y: 100 }, // left of the region
        { t: 20, x: 1900, y: 400 }, // right of it
      ]),
      0,
      { width: 640, height: 360 },
      false,
      { frame: { width: 1920, height: 1080 }, x: 400, y: 300 }
    );
    expect(s.samples).toHaveLength(1);
    expect(s.samples[0]).toMatchObject({ x: 100, y: 100 });
  });

  it("behaves exactly as before when no region was recorded", () => {
    const samples = [{ t: 0, x: 960, y: 540 }];
    const withCrop = toSidecar(rec(samples), 0, { width: 1920, height: 1080 }, false);
    expect(withCrop.samples[0]).toMatchObject({ x: 960, y: 540 });
  });

  it("keeps click state on a shifted sample", () => {
    const s = toSidecar(
      { ...rec([]), samples: [{ t: 0, x: 500, y: 400, down: 1 }] },
      0,
      { width: 640, height: 360 },
      false,
      { frame: { width: 1920, height: 1080 }, x: 400, y: 300 }
    );
    expect(s.samples[0]!.down).toBe(1);
  });
});
