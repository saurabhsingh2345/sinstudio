import { describe, it, expect } from "vitest";
import {
  SMART_FOCUS_DEFAULTS,
  centerOffset,
  clickEvents,
  clusterEvents,
  dwellEvents,
  findFocusSegments,
  smartFocus,
  type SmartFocusOptions,
} from "./smartFocus";
import type { CursorSample } from "./cursor";
import { kfValue } from "./components/studio/preview-engine";

const opts = (over: Partial<SmartFocusOptions> = {}): SmartFocusOptions => ({
  ...SMART_FOCUS_DEFAULTS,
  ...over,
});

/** A pointer parked at (x,y) from t0 for `secs`, sampled at the heartbeat rate. */
function park(t0: number, secs: number, x: number, y: number): CursorSample[] {
  const out: CursorSample[] = [];
  for (let t = t0; t <= t0 + secs * 1000; t += 250) out.push({ t, x, y });
  return out;
}

describe("centerOffset", () => {
  // The property that keeps a zoom from showing background: at scale 1 the clip
  // exactly fills the canvas, so it cannot pan at all.
  it("refuses to pan at scale 1", () => {
    expect(centerOffset(0, 1920, 1)).toBe(0);
    expect(centerOffset(1920, 1920, 1)).toBe(0);
    expect(centerOffset(300, 1920, 1)).toBe(0);
  });

  it("centres the requested point when there is room", () => {
    // At 2x on a 1920 canvas the frame is 3840 wide, overhanging 960 per side.
    // Bringing x=660 to centre needs 2*(960-660) = 600, inside that bound.
    expect(centerOffset(660, 1920, 2)).toBe(600);
  });

  it("clamps rather than pulling the frame edge into view", () => {
    // Centring x=0 would need +1920, but only 960 of overhang exists.
    expect(centerOffset(0, 1920, 2)).toBe(960);
    expect(centerOffset(1920, 1920, 2)).toBe(-960);
  });
});

describe("event detection", () => {
  it("takes one click per press edge, not per sample", () => {
    const samples: CursorSample[] = [
      { t: 0, x: 5, y: 5 },
      { t: 100, x: 5, y: 5, down: 1 },
      { t: 200, x: 5, y: 5, down: 1 },
      { t: 300, x: 5, y: 5 },
      { t: 400, x: 5, y: 5, down: 1 },
    ];
    expect(clickEvents(samples).map((e) => e.start)).toEqual([0.1, 0.4]);
  });

  it("finds a dwell and puts the focus at its centroid", () => {
    const samples = park(0, 2, 400, 300);
    const got = dwellEvents(samples, 60, 1);
    expect(got).toHaveLength(1);
    expect(got[0].x).toBe(400);
    expect(got[0].y).toBe(300);
    expect(got[0].end - got[0].start).toBeGreaterThanOrEqual(1);
  });

  // The failure this actually had: a pointer creeping across the screen stayed
  // inside the radius of a centroid that crept with it, so a whole recording
  // read as one enormous dwell and produced a single zoom over everything.
  it("does not mistake a slow drift for a dwell", () => {
    const drifting: CursorSample[] = [];
    for (let i = 0; i < 120; i++) drifting.push({ t: i * 33, x: 100 + i * 12, y: 100 + i * 5 });
    const got = dwellEvents(drifting, 60, 1);
    for (const d of got) {
      expect(d.end - d.start, "a drift produced a long dwell").toBeLessThan(1.5);
    }
  });

  it("ignores a pointer just passing through", () => {
    const moving: CursorSample[] = [];
    for (let i = 0; i < 20; i++) moving.push({ t: i * 100, x: i * 100, y: i * 50 });
    expect(dwellEvents(moving, 60, 1)).toHaveLength(0);
  });
});

describe("clustering", () => {
  // Three clicks on the same button is one zoom. Three separate zooms would be
  // unwatchable.
  it("merges events close in time and space", () => {
    const got = clusterEvents(
      [
        { start: 1, end: 1, x: 100, y: 100 },
        { start: 1.5, end: 1.5, x: 120, y: 110 },
        { start: 2, end: 2, x: 110, y: 105 },
      ],
      2.5,
      320
    );
    expect(got).toHaveLength(1);
    expect(got[0].start).toBe(1);
    expect(got[0].end).toBe(2);
  });

  it("keeps events far apart in space separate even when close in time", () => {
    const got = clusterEvents(
      [
        { start: 1, end: 1, x: 100, y: 100 },
        { start: 1.5, end: 1.5, x: 1500, y: 900 },
      ],
      2.5,
      320
    );
    expect(got).toHaveLength(2);
  });

  it("keeps events far apart in time even when close in space", () => {
    const got = clusterEvents(
      [
        { start: 1, end: 1, x: 100, y: 100 },
        { start: 30, end: 30, x: 100, y: 100 },
      ],
      2.5,
      320
    );
    expect(got).toHaveLength(2);
  });
});

describe("segments", () => {
  it("gives every zoom at least the minimum hold", () => {
    const samples: CursorSample[] = [{ t: 5000, x: 400, y: 300, down: 1 }];
    const segs = findFocusSegments({ samples }, 20, opts({ useDwell: false, minHold: 2 }));
    expect(segs).toHaveLength(1);
    expect(segs[0].end - segs[0].start).toBeGreaterThanOrEqual(2 - 1e-6);
  });

  it("merges zooms whose minimum holds overlap", () => {
    // Two clicks 0.5s apart, each widened to the 1.2s minimum hold, end up
    // overlapping in time — and two zooms cannot be held at once.
    const samples: CursorSample[] = [
      { t: 5000, x: 100, y: 100, down: 1 },
      { t: 5100, x: 100, y: 100 },
      { t: 5500, x: 1500, y: 800, down: 1 },
    ];
    const segs = findFocusSegments({ samples }, 20, opts({ useDwell: false, ramp: 0.7 }));
    expect(segs).toHaveLength(1);
  });

  it("finds nothing in a recording with no clicks and no dwell", () => {
    const moving: CursorSample[] = [];
    for (let i = 0; i < 40; i++) moving.push({ t: i * 100, x: i * 40, y: i * 20 });
    expect(findFocusSegments({ samples: moving }, 10, opts())).toHaveLength(0);
  });
});

describe("keyframe emission", () => {
  const canvas = { width: 1920, height: 1080 };
  const video = { width: 1920, height: 1080 };

  it("produces nothing when there is nothing to focus on", () => {
    const { keyframes } = smartFocus({ samples: [], video }, 10, canvas, opts());
    expect(Object.keys(keyframes)).toHaveLength(0);
  });

  it("starts and ends wide", () => {
    const samples: CursorSample[] = [{ t: 5000, x: 1400, y: 800, down: 1 }];
    const { keyframes } = smartFocus({ samples, video }, 12, canvas, opts({ useDwell: false }));
    expect(keyframes.scale[0]).toMatchObject({ t: 0, value: 1 });
    expect(keyframes.scale[keyframes.scale.length - 1].value).toBe(1);
  });

  it("emits scale, x and y keyed at the same times, so they stay consistent", () => {
    const samples: CursorSample[] = [{ t: 5000, x: 1400, y: 800, down: 1 }];
    const { keyframes } = smartFocus({ samples, video }, 12, canvas, opts({ useDwell: false }));
    const ts = (k: string) => keyframes[k].map((p) => p.t);
    expect(ts("x")).toEqual(ts("scale"));
    expect(ts("y")).toEqual(ts("scale"));
  });

  // The load-bearing property. If the pan ever outruns the zoom, the frame's
  // edge comes inside the canvas and the viewer sees background — which looks
  // like a broken render, not a stylistic choice.
  it("never pans further than the zoom allows, at any point in the ramp", () => {
    const samples: CursorSample[] = [
      { t: 3000, x: 40, y: 30, down: 1 }, // hard against the top-left corner
      { t: 9000, x: 1880, y: 1050, down: 1 }, // and the bottom-right
    ];
    const { keyframes } = smartFocus({ samples, video }, 14, canvas, opts({ useDwell: false, zoom: 1.8 }));

    for (let t = 0; t <= 14; t += 0.05) {
      const s = kfValue(keyframes.scale, t);
      const x = kfValue(keyframes.x, t);
      const y = kfValue(keyframes.y, t);
      const boundX = (canvas.width * (s - 1)) / 2;
      const boundY = (canvas.height * (s - 1)) / 2;
      // A hair of tolerance for the rounding applied when keys are written.
      expect(Math.abs(x), `x at t=${t.toFixed(2)} (scale ${s.toFixed(3)})`).toBeLessThanOrEqual(boundX + 1.5);
      expect(Math.abs(y), `y at t=${t.toFixed(2)} (scale ${s.toFixed(3)})`).toBeLessThanOrEqual(boundY + 1.5);
    }
  });

  it("scales focus points from the recording's space into the canvas", () => {
    // Track recorded at 3840x2160, canvas 1920x1080: everything halves.
    const samples: CursorSample[] = [{ t: 5000, x: 2880, y: 1620, down: 1 }];
    const { keyframes } = smartFocus(
      { samples, video: { width: 3840, height: 2160 } },
      12,
      canvas,
      opts({ useDwell: false, zoom: 2 })
    );
    // 2880 → 1440 canvas px. Offset = 2*(960-1440) = -960, at the clamp bound.
    const held = keyframes.x.find((k) => k.value !== 0);
    expect(held?.value).toBe(-960);
  });

  it("respects a custom zoom level", () => {
    const samples: CursorSample[] = [{ t: 5000, x: 960, y: 540, down: 1 }];
    for (const z of [1.3, 2.4]) {
      const { keyframes } = smartFocus({ samples, video }, 12, canvas, opts({ useDwell: false, zoom: z }));
      expect(Math.max(...keyframes.scale.map((k) => k.value))).toBeCloseTo(z, 4);
    }
  });

  // Pulling out to full frame and back for a target 1s away reads as a flinch.
  // Camtasia pans; so do we — and the pan must not dip toward full frame.
  it("pans between nearby targets instead of zooming out", () => {
    const samples: CursorSample[] = [
      { t: 3000, x: 300, y: 300, down: 1 },
      { t: 3100, x: 300, y: 300 }, // release, or the next press isn't an edge
      // Close enough that there is no room to pull out and push back in.
      { t: 4200, x: 1600, y: 800, down: 1 },
      { t: 4300, x: 1600, y: 800 },
    ];
    const o = opts({ useDwell: false, zoom: 1.7, ramp: 0.7, minHold: 1.0 });
    const { keyframes, segments } = smartFocus({ samples, video }, 12, canvas, o);
    expect(segments).toHaveLength(2);

    // Across the span between the two holds the zoom must never drop back.
    const between = [segments[0].end, segments[1].start];
    for (let t = between[0]; t <= between[1]; t += 0.05) {
      expect(kfValue(keyframes.scale, t), `scale dipped at t=${t.toFixed(2)}`).toBeGreaterThan(1.05);
    }
    // And the pan must actually travel between the two targets.
    const x0 = kfValue(keyframes.x, segments[0].start);
    const x1 = kfValue(keyframes.x, segments[1].end);
    expect(Math.abs(x1 - x0)).toBeGreaterThan(100);
  });

  it("does pull back to full frame when there is time", () => {
    const samples: CursorSample[] = [
      { t: 2000, x: 300, y: 300, down: 1 },
      { t: 2100, x: 300, y: 300 },
      { t: 14000, x: 1600, y: 800, down: 1 },
      { t: 14100, x: 1600, y: 800 },
    ];
    const o = opts({ useDwell: false, ramp: 0.5, minHold: 1.0 });
    const { keyframes, segments } = smartFocus({ samples, video }, 20, canvas, o);
    expect(segments).toHaveLength(2);
    const mid = (segments[0].end + segments[1].start) / 2;
    expect(kfValue(keyframes.scale, mid)).toBeCloseTo(1, 3);
  });

  it("keeps every key inside the clip", () => {
    // A click right at the end must not key past the clip's duration.
    const samples: CursorSample[] = [{ t: 11800, x: 500, y: 400, down: 1 }];
    const { keyframes } = smartFocus({ samples, video }, 12, canvas, opts({ useDwell: false }));
    for (const list of Object.values(keyframes)) {
      for (const k of list) {
        expect(k.t).toBeGreaterThanOrEqual(0);
        expect(k.t).toBeLessThanOrEqual(12);
      }
    }
  });
});
