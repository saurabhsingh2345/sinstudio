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

describe("focus radii scale with the recording", () => {
  /*
   * dwellRadius and clusterRadius describe how far the HAND moved, not a number
   * of pixels, so they are quoted at a 1920-wide reference and scaled to the
   * recording they are measured in. Left absolute, the identical session finds
   * fewer dwells the higher the capture resolution — the feature quietly
   * getting worse on better hardware.
   *
   * The amplitude below is not arbitrary. dwellEvents retries from every
   * sample, so a run beginning at the MIDDLE of a symmetric wander sees only
   * half its spread — which means a gentle drift stays inside the radius at
   * every resolution and a test built on one passes with the bug still in
   * place. The first version of this test did exactly that. A 90px spread at
   * the 1920 reference puts the midpoint 45px from the edges (inside the 60px
   * radius) and its 4K twin 90px away (outside it), so the two resolutions
   * genuinely disagree unless the radius scales.
   */
  const drift = (w: number) => {
    const k = w / 1920;
    const samples = [];
    for (let i = 0; i <= 30; i++) {
      samples.push({ t: i * 100, x: Math.round((900 + (i % 3) * 45) * k), y: Math.round(500 * k) });
    }
    return { samples, video: { width: w, height: Math.round((w * 9) / 16) } };
  };

  it("finds the same dwell at 1080p, Retina and 4K", () => {
    const counts = [1920, 2072, 3840].map(
      (w) => findFocusSegments(drift(w), 5, SMART_FOCUS_DEFAULTS).length
    );
    expect(counts[0]).toBeGreaterThan(0);
    // The gesture is identical in each; so must the answer be.
    expect(new Set(counts).size).toBe(1);
  });

  // The failure mode itself: at a fixed pixel radius the 4K capture loses the
  // dwell that the 1080p one finds.
  it("a fixed pixel radius loses the dwell at 4K", () => {
    const r = SMART_FOCUS_DEFAULTS.dwellRadius;
    expect(dwellEvents(drift(1920).samples, r, SMART_FOCUS_DEFAULTS.dwellTime).length).toBeGreaterThan(0);
    expect(dwellEvents(drift(3840).samples, r, SMART_FOCUS_DEFAULTS.dwellTime).length).toBe(0);
    // Scaled to the recording, it is found again.
    expect(dwellEvents(drift(3840).samples, r * 2, SMART_FOCUS_DEFAULTS.dwellTime).length).toBeGreaterThan(0);
  });

  it("still works when a sidecar carries no frame size", () => {
    const { samples } = drift(1920);
    expect(() => findFocusSegments({ samples }, 5, SMART_FOCUS_DEFAULTS)).not.toThrow();
    expect(findFocusSegments({ samples }, 5, SMART_FOCUS_DEFAULTS).length).toBeGreaterThan(0);
  });
});

describe("revisited areas earn a deeper zoom", () => {
  /*
   * Coming back to a place is the strongest statement a recording makes about
   * what matters in it — stronger than any single click, because it is the
   * difference between passing over something and working on it. A flat zoom
   * treats a spot glanced at once and a spot returned to five times the same,
   * which is the camera declining to read the room.
   */
  const canvas = { width: 1920, height: 1080 };
  const video = { width: 1920, height: 1080 };

  /*
   * A visit: click somewhere, then sweep away and back again.
   *
   * Both halves matter, and both were wrong in earlier versions of this
   * fixture. Each press needs a RELEASE, because clickEvents fires on press
   * edges and a run of down samples is one held button rather than several
   * clicks. And the pointer has to LEAVE, because a motionless pointer is one
   * enormous dwell that swallows every click inside it and collapses the whole
   * recording into a single segment — which is what "returning to an area"
   * means anyway: you cannot return without having left.
   */
  const visits = (times: number, x = 500, y = 400) => {
    const samples: CursorSample[] = [];
    for (let i = 0; i < times; i++) {
      const t0 = i * 8000;
      samples.push({ t: t0, x, y, down: 1 });
      samples.push({ t: t0 + 120, x, y });
      // Away...
      for (let k = 1; k <= 12; k++) samples.push({ t: t0 + 120 + k * 400, x: x + k * 90, y: y + k * 30 });
      // ...and back, without pausing long enough anywhere to register a dwell.
      for (let k = 11; k >= 1; k--) samples.push({ t: t0 + 120 + (24 - k) * 400, x: x + k * 90, y: y + k * 30 });
    }
    return samples;
  };

  it("pushes further the more often an area is returned to", () => {
    const zoomFor = (n: number) => {
      const segs = findFocusSegments({ samples: visits(n), video }, 90, SMART_FOCUS_DEFAULTS);
      return Math.max(...segs.map((s) => s.zoom ?? 0));
    };
    const one = zoomFor(1);
    const two = zoomFor(2);
    const four = zoomFor(4);
    expect(one).toBeCloseTo(SMART_FOCUS_DEFAULTS.zoom, 6);
    expect(two).toBeGreaterThan(one);
    expect(four).toBeGreaterThan(two);
  });

  it("counts the visits it found", () => {
    const segs = findFocusSegments({ samples: visits(3), video }, 90, SMART_FOCUS_DEFAULTS);
    expect(segs.length).toBe(3);
    for (const s of segs) expect(s.visits).toBe(3);
  });

  // Two places worked on separately must not inflate each other.
  it("does not credit a return to a different part of the screen", () => {
    const samples = [
      ...visits(3, 300, 300),
      ...visits(1, 1500, 800).map((v) => ({ ...v, t: v.t + 40000 })),
    ].sort((a, b) => a.t - b.t);
    const segs = findFocusSegments({ samples, video }, 90, SMART_FOCUS_DEFAULTS);
    const near = segs.filter((s) => s.x < 900);
    const far = segs.filter((s) => s.x >= 900);
    expect(near.every((s) => (s.visits ?? 0) >= 3)).toBe(true);
    expect(far.every((s) => s.visits === 1)).toBe(true);
    expect(Math.max(...far.map((s) => s.zoom!))).toBeCloseTo(SMART_FOCUS_DEFAULTS.zoom, 6);
  });

  it("stops escalating at the ceiling", () => {
    const segs = findFocusSegments({ samples: visits(12), video }, 200, SMART_FOCUS_DEFAULTS);
    expect(Math.max(...segs.map((s) => s.zoom!))).toBeLessThanOrEqual(SMART_FOCUS_DEFAULTS.revisitMax + 1e-9);
  });

  /*
   * The ceiling bounds the escalation, never the chosen zoom. Asked for 2.4x
   * with a 1.95 ceiling this must give 2.4 — a cap that can reduce the setting
   * above it is a setting that silently does not work. This is exactly what
   * broke when the escalation first went in.
   */
  it("never reduces a zoom that was asked for explicitly", () => {
    const opts = { ...SMART_FOCUS_DEFAULTS, zoom: 2.4 };
    const segs = findFocusSegments({ samples: visits(1), video }, 40, opts);
    expect(segs[0]!.zoom).toBeCloseTo(2.4, 6);
  });

  /*
   * A deeper zoom may pan further, so the clamp has to be computed against the
   * segment's OWN scale. Using the default would either waste the headroom or,
   * far worse, run past it and show the background.
   */
  it("still never uncovers the canvas at the deeper zoom", () => {
    // A corner, revisited: maximum escalation and maximum pan at once.
    const { keyframes } = smartFocus(
      { samples: visits(5, 60, 60), video },
      120,
      canvas,
      SMART_FOCUS_DEFAULTS
    );
    for (let t = 0; t <= 120; t += 0.05) {
      const s = kfValue(keyframes.scale!, t);
      const x = keyframes.x?.length ? kfValue(keyframes.x, t) : 0;
      const y = keyframes.y?.length ? kfValue(keyframes.y, t) : 0;
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(Math.abs(x)).toBeLessThanOrEqual((canvas.width * (s - 1)) / 2 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual((canvas.height * (s - 1)) / 2 + 1e-6);
    }
  });
});
