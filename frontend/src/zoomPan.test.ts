import { describe, it, expect } from "vitest";
import { kfValue } from "./components/studio/preview-engine";
import type { Keyframe } from "./types";
import {
  DEFAULT_EASE,
  MAX_CAM_SPEED,
  MAX_ZOOM,
  applyZoomStops,
  clampRect,
  contentBox,
  fullFrame,
  readZoomStops,
  rectForZoom,
  rectToTransform,
  transformToRect,
  upsertStop,
  zoomKeyframes,
  type Rect,
  type ZoomStop,
} from "./zoomPan";

const canvas = { width: 1920, height: 1080 };

const stop = (over: Partial<ZoomStop> = {}): ZoomStop => ({
  start: 3,
  end: 5,
  rect: { x: 480, y: 270, w: 960, h: 540 },
  ramp: 0.7,
  ease: DEFAULT_EASE,
  ...over,
});

const near = (a: Rect, b: Rect, tol = 0.5) => {
  expect(a.x).toBeCloseTo(b.x, tol);
  expect(a.y).toBeCloseTo(b.y, tol);
  expect(a.w).toBeCloseTo(b.w, tol);
  expect(a.h).toBeCloseTo(b.h, tol);
};

describe("clampRect", () => {
  it("forces the canvas aspect, since one scale drives both axes", () => {
    const r = clampRect({ x: 0, y: 0, w: 960, h: 900 }, canvas);
    expect(r.w / r.h).toBeCloseTo(canvas.width / canvas.height, 6);
  });

  it("keeps the rectangle inside the canvas", () => {
    const r = clampRect({ x: 1800, y: 1000, w: 960, h: 540 }, canvas);
    expect(r.x + r.w).toBeLessThanOrEqual(canvas.width);
    expect(r.y + r.h).toBeLessThanOrEqual(canvas.height);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });

  it("refuses to zoom past the point where there is no detail left", () => {
    const r = clampRect({ x: 0, y: 0, w: 1, h: 1 }, canvas);
    expect(canvas.width / r.w).toBeCloseTo(MAX_ZOOM, 6);
  });

  it("refuses to zoom out past the full frame", () => {
    const r = clampRect({ x: -500, y: -500, w: 5000, h: 3000 }, canvas);
    near(r, fullFrame(canvas));
  });
});

describe("rect ↔ transform", () => {
  it("round-trips any rectangle that is already legal", () => {
    for (const r of [
      { x: 0, y: 0, w: 960, h: 540 },
      { x: 960, y: 540, w: 960, h: 540 },
      { x: 640, y: 360, w: 640, h: 360 },
      fullFrame(canvas),
    ]) {
      const t = rectToTransform(r, canvas);
      near(transformToRect(t.scale, t.x, t.y, canvas), r);
    }
  });

  it("centring the canvas centre needs no pan", () => {
    const t = rectToTransform(rectForZoom(2, { x: 960, y: 540 }, canvas), canvas);
    expect(t.scale).toBeCloseTo(2, 6);
    expect(t.x).toBe(0);
    expect(t.y).toBe(0);
  });

  it("the full frame is scale 1 and cannot pan", () => {
    const t = rectToTransform(fullFrame(canvas), canvas);
    expect(t).toEqual({ scale: 1, x: 0, y: 0 });
  });

  // The rectangle is what stops the pan running past the zoom: a corner target
  // is clamped into a legal rectangle before it ever becomes an offset.
  it("a corner target never asks to pan further than the zoom allows", () => {
    const r = rectForZoom(1.5, { x: 0, y: 0 }, canvas);
    const t = rectToTransform(r, canvas);
    expect(Math.abs(t.x)).toBeLessThanOrEqual((canvas.width * (t.scale - 1)) / 2 + 1e-6);
    expect(Math.abs(t.y)).toBeLessThanOrEqual((canvas.height * (t.scale - 1)) / 2 + 1e-6);
  });
});

describe("zoomKeyframes", () => {
  it("starts and ends at full frame", () => {
    const kf = zoomKeyframes([{ start: 3, end: 5, scale: 2, x: 100, y: 50, ramp: 0.7, ease: DEFAULT_EASE }], 10);
    expect(kf.scale[0]).toMatchObject({ t: 0, value: 1 });
    expect(kf.scale[kf.scale.length - 1].value).toBe(1);
  });

  it("keys scale, x and y at identical times so they stay consistent", () => {
    const kf = zoomKeyframes(
      [
        { start: 2, end: 3, scale: 1.8, x: 200, y: 100, ramp: 0.5, ease: DEFAULT_EASE },
        { start: 8, end: 9, scale: 2.4, x: -300, y: -150, ramp: 0.5, ease: DEFAULT_EASE },
      ],
      12
    );
    expect(kf.x.map((k) => k.t)).toEqual(kf.scale.map((k) => k.t));
    expect(kf.y.map((k) => k.t)).toEqual(kf.scale.map((k) => k.t));
  });

  it("holds the requested zoom for the whole stop", () => {
    const kf = zoomKeyframes([{ start: 3, end: 6, scale: 2.5, x: 400, y: 200, ramp: 0.6, ease: DEFAULT_EASE }], 10);
    for (let t = 3; t <= 6; t += 0.1) {
      expect(kfValue(kf.scale, t), `scale at ${t.toFixed(1)}`).toBeCloseTo(2.5, 3);
    }
  });

  it("orders stops given out of order", () => {
    const kf = zoomKeyframes(
      [
        { start: 8, end: 9, scale: 2, x: 0, y: 0, ramp: 0.5, ease: DEFAULT_EASE },
        { start: 2, end: 3, scale: 3, x: 0, y: 0, ramp: 0.5, ease: DEFAULT_EASE },
      ],
      12
    );
    expect(kfValue(kf.scale, 2.5)).toBeCloseTo(3, 3);
    expect(kfValue(kf.scale, 8.5)).toBeCloseTo(2, 3);
  });

  // Same property SmartFocus is held to: the pan may never outrun the zoom, at
  // any instant, or the frame's edge comes into view as visible background.
  it("never pans further than the zoom allows, mid-ramp included", () => {
    const stops: ZoomStop[] = [
      stop({ start: 2, end: 3.5, rect: rectForZoom(1.7, { x: 0, y: 0 }, canvas) }),
      stop({ start: 5, end: 6.5, rect: rectForZoom(2.6, { x: 1920, y: 1080 }, canvas) }),
    ];
    const kf = zoomKeyframes(
      stops.map((s) => ({ ...rectToTransform(s.rect, canvas), start: s.start, end: s.end, ramp: s.ramp, ease: s.ease })),
      10
    );
    for (let t = 0; t <= 10; t += 0.05) {
      const s = kfValue(kf.scale, t);
      const bx = (canvas.width * (s - 1)) / 2;
      const by = (canvas.height * (s - 1)) / 2;
      expect(Math.abs(kfValue(kf.x, t)), `x at t=${t.toFixed(2)}`).toBeLessThanOrEqual(bx + 1.5);
      expect(Math.abs(kfValue(kf.y, t)), `y at t=${t.toFixed(2)}`).toBeLessThanOrEqual(by + 1.5);
    }
  });

  it("pans between neighbours too close to pull back between", () => {
    const kf = zoomKeyframes(
      [
        { start: 2, end: 3, scale: 1.8, x: 400, y: 0, ramp: 0.7, ease: DEFAULT_EASE },
        { start: 3.5, end: 4.5, scale: 1.8, x: -400, y: 0, ramp: 0.7, ease: DEFAULT_EASE },
      ],
      10
    );
    for (let t = 3; t <= 3.5; t += 0.05) {
      expect(kfValue(kf.scale, t), `dipped at ${t.toFixed(2)}`).toBeGreaterThan(1.05);
    }
  });

  it("pulls back to full frame when there is room", () => {
    const kf = zoomKeyframes(
      [
        { start: 2, end: 3, scale: 2, x: 400, y: 0, ramp: 0.5, ease: DEFAULT_EASE },
        { start: 12, end: 13, scale: 2, x: -400, y: 0, ramp: 0.5, ease: DEFAULT_EASE },
      ],
      16
    );
    expect(kfValue(kf.scale, 7)).toBeCloseTo(1, 3);
  });
});

describe("readZoomStops", () => {
  it("recovers what was written", () => {
    const stops = [
      stop({ start: 2, end: 4, rect: rectForZoom(2, { x: 600, y: 400 }, canvas), ramp: 0.6 }),
      stop({ start: 9, end: 11, rect: rectForZoom(3, { x: 1400, y: 800 }, canvas), ramp: 0.6 }),
    ];
    const kf = applyZoomStops(undefined, stops, 16, canvas)!;
    const got = readZoomStops(kf, canvas);

    expect(got).toHaveLength(2);
    got.forEach((g, i) => {
      expect(g.start).toBeCloseTo(stops[i].start, 3);
      expect(g.end).toBeCloseTo(stops[i].end, 3);
      expect(g.ramp).toBeCloseTo(stops[i].ramp, 3);
      near(g.rect, stops[i].rect, 1);
    });
  });

  it("reads nothing out of an unzoomed clip", () => {
    expect(readZoomStops(undefined, canvas)).toEqual([]);
    expect(readZoomStops({ scale: [{ t: 0, value: 1 }] }, canvas)).toEqual([]);
    expect(readZoomStops({ opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }, canvas)).toEqual([]);
  });

  // A pan holds one scale across two different positions. It is motion between
  // stops, and listing it as a third stop would let the editor "delete" a move
  // that isn't there.
  it("does not mistake a pan for a stop", () => {
    const kf = zoomKeyframes(
      [
        { start: 2, end: 3, scale: 1.8, x: 400, y: 0, ramp: 0.7, ease: DEFAULT_EASE },
        { start: 3.5, end: 4.5, scale: 1.8, x: -400, y: 0, ramp: 0.7, ease: DEFAULT_EASE },
      ],
      10
    );
    expect(readZoomStops(kf, canvas)).toHaveLength(2);
  });

  it("survives keyframes hand-edited out of alignment on the timeline", () => {
    // scale keyed at 2/4, x keyed only at 0 and 6 — no key-for-key partner.
    const got = readZoomStops(
      {
        scale: [{ t: 0, value: 1 }, { t: 2, value: 2 }, { t: 4, value: 2 }, { t: 6, value: 1 }],
        x: [{ t: 0, value: 0 }, { t: 6, value: 0 }],
        y: [{ t: 0, value: 0 }, { t: 6, value: 0 }],
      },
      canvas
    );
    expect(got).toHaveLength(1);
    expect(got[0].start).toBe(2);
    expect(got[0].end).toBe(4);
  });

  // Found on a real project: a zoom that only ever panned sideways has scale
  // and x keys but no y at all, and sampling an empty keyframe list throws.
  it("reads a clip that is keyed on some axes but not others", () => {
    const got = readZoomStops(
      {
        scale: [{ t: 0, value: 1 }, { t: 2, value: 2 }, { t: 4, value: 2 }, { t: 6, value: 1 }],
        x: [{ t: 0, value: 0 }, { t: 2, value: 300 }, { t: 4, value: 300 }, { t: 6, value: 0 }],
      },
      canvas
    );
    expect(got).toHaveLength(1);
    expect(got[0].rect.y).toBeCloseTo((canvas.height - canvas.height / 2) / 2, 3);
  });

  it("round-trips through an edit without drifting", () => {
    const first = [stop({ start: 2, end: 4, rect: rectForZoom(2.5, { x: 700, y: 300 }, canvas) })];
    let kf = applyZoomStops(undefined, first, 12, canvas);
    for (let i = 0; i < 4; i++) kf = applyZoomStops(kf, readZoomStops(kf, canvas), 12, canvas);
    const got = readZoomStops(kf, canvas);
    expect(got).toHaveLength(1);
    near(got[0].rect, first[0].rect, 1);
  });
});

describe("applyZoomStops", () => {
  it("leaves keyframes zoom does not drive alone", () => {
    const kf = applyZoomStops({ opacity: [{ t: 0, value: 0 }], rotation: [{ t: 1, value: 90 }] }, [stop()], 10, canvas)!;
    expect(kf.opacity).toEqual([{ t: 0, value: 0 }]);
    expect(kf.rotation).toEqual([{ t: 1, value: 90 }]);
    expect(kf.scale.length).toBeGreaterThan(0);
  });

  it("clearing every stop drops the zoom keys and keeps the rest", () => {
    const kf = applyZoomStops({ opacity: [{ t: 0, value: 0 }] }, [], 10, canvas)!;
    expect(kf).toEqual({ opacity: [{ t: 0, value: 0 }] });
  });

  it("clearing the last stop of a clip with nothing else leaves no keyframes", () => {
    expect(applyZoomStops({ scale: [{ t: 0, value: 1 }] }, [], 10, canvas)).toBeUndefined();
  });
});

describe("upsertStop", () => {
  it("keeps the list ordered", () => {
    const out = upsertStop([stop({ start: 8, end: 9 })], stop({ start: 2, end: 3 }));
    expect(out.map((s) => s.start)).toEqual([2, 8]);
  });

  it("replaces a stop it overlaps rather than holding two zooms at once", () => {
    const out = upsertStop([stop({ start: 2, end: 5 })], stop({ start: 3, end: 6 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: 3, end: 6 });
  });

  it("leaves stops that merely touch", () => {
    const out = upsertStop([stop({ start: 0, end: 2 }), stop({ start: 4, end: 6 })], stop({ start: 2, end: 4 }));
    expect(out.map((s) => s.start)).toEqual([0, 2, 4]);
  });
});

describe("spring easing safety", () => {
  const canvas = { width: 1920, height: 1080 };
  // Sample far more densely than the ramps, since an overshoot is a brief
  // excursion in the middle of a segment — checking only at the keyframes is
  // exactly how this bug would survive a test suite.
  const sampleAll = (kf: Record<string, Keyframe[]>, duration: number) => {
    const out: { t: number; s: number; x: number; y: number }[] = [];
    for (let t = 0; t <= duration; t += 0.01) {
      out.push({
        t,
        s: kfValue(kf.scale!, t),
        x: kf.x?.length ? kfValue(kf.x, t) : 0,
        y: kf.y?.length ? kfValue(kf.y, t) : 0,
      });
    }
    return out;
  };

  const holds = (ease: string) => [
    { start: 2, end: 4, scale: 1.6, x: 380, y: -200, ramp: 0.7, ease },
    // Close behind the first, so this pair pans rather than pulling out.
    { start: 5, end: 6.5, scale: 1.6, x: -420, y: 180, ramp: 0.7, ease },
    // Far enough away to force a full pull-out and push-in.
    { start: 11, end: 13, scale: 2.2, x: 500, y: 260, ramp: 0.7, ease },
  ];

  /*
   * THE regression this guards.
   *
   * A spring overshoots its destination, and every segment except the push-in
   * ends on a hard limit: scale returns to exactly 1, and a pan's endpoints are
   * clamped to exactly what that scale can cover. Overshooting either shows the
   * background behind the clip for a few frames — a flash of backdrop mid-zoom,
   * which is far more noticeable than the easing that caused it.
   */
  it("never lets scale dip below full frame", () => {
    const kf = zoomKeyframes(holds("springOut"), 16);
    for (const p of sampleAll(kf, 16)) {
      expect(p.s).toBeGreaterThanOrEqual(1 - 1e-9);
    }
  });

  it("never pans further than the current scale can cover", () => {
    const kf = zoomKeyframes(holds("springOut"), 16);
    for (const p of sampleAll(kf, 16)) {
      // At scale s the clip overhangs by size*(s-1)/2 per side; beyond that its
      // own edge comes inside the canvas.
      const boundX = (canvas.width * (p.s - 1)) / 2;
      const boundY = (canvas.height * (p.s - 1)) / 2;
      expect(Math.abs(p.x)).toBeLessThanOrEqual(boundX + 1e-6);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(boundY + 1e-6);
    }
  });

  it("holds for every overshooting curve, not just the spring", () => {
    for (const ease of ["springOut", "easeOutBack", "easeOutElastic"]) {
      const kf = zoomKeyframes(holds(ease), 16);
      for (const p of sampleAll(kf, 16)) {
        expect(p.s).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(Math.abs(p.x)).toBeLessThanOrEqual((canvas.width * (p.s - 1)) / 2 + 1e-6);
      }
    }
  });

  // The point of all this: the spring must actually survive where it is wanted.
  // A "fix" that stripped overshoot everywhere would pass the tests above and
  // deliver none of the feel.
  it("still overshoots on the way in", () => {
    const kf = zoomKeyframes([{ start: 3, end: 5, scale: 1.6, x: 0, y: 0, ramp: 0.7, ease: "springOut" }], 8);
    const peak = Math.max(...sampleAll(kf, 8).map((p) => p.s));
    expect(peak).toBeGreaterThan(1.6);
  });

  it("does not overshoot on the way out", () => {
    const kf = zoomKeyframes([{ start: 3, end: 5, scale: 1.6, x: 0, y: 0, ramp: 0.7, ease: "springOut" }], 8);
    // After the hold ends, scale only descends toward 1 and never past it.
    const tail = sampleAll(kf, 8).filter((p) => p.t > 5);
    expect(Math.min(...tail.map((p) => p.s))).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it("keeps a non-overshooting choice exactly as it was", () => {
    const kf = zoomKeyframes(holds("easeInOut"), 16);
    for (const arr of [kf.scale!, kf.x!, kf.y!]) {
      for (const k of arr) expect(["easeInOut", "linear"]).toContain(k.ease);
    }
  });
});

describe("ramps have room", () => {
  /*
   * `at` clamps every keyframe into [0, duration], so before holds were fitted
   * a zoom ending near the clip's end had its pull-out compressed into whatever
   * time remained. On a real 3.7s recording that was a 0.165s pull-out against
   * a requested 0.9s — a snap, and with a spring on the push-in, a snap that
   * bounces. Only long recordings were unaffected, which is why it survived.
   */
  const rampsIn = (kf: Record<string, Keyframe[]>) => {
    const s = kf.scale ?? [];
    return s
      .slice(1)
      .map((k, i) => ({ secs: +(k.t - s[i]!.t).toFixed(3), dv: k.value - s[i]!.value }))
      .filter((g) => Math.abs(g.dv) > 1e-9)
      .map((g) => g.secs);
  };

  const hold = (start: number, end: number, ramp = 0.9) => [
    { start, end, scale: 1.6, x: 200, y: -100, ramp, ease: "springOut" },
  ];

  it("never compresses a ramp, wherever the zoom falls in the clip", () => {
    // A zoom hard against the end is the case that used to snap.
    for (const [h, dur] of [
      [hold(2.42, 3.52), 3.685],
      [hold(3.5, 4.9), 5.11],
      [hold(0, 1.2), 6],
      [hold(4.8, 6), 6],
    ] as const) {
      for (const secs of rampsIn(zoomKeyframes(h as never, dur))) {
        expect(secs).toBeCloseTo(0.9, 3);
      }
    }
  });

  // No zoom is better than one that snaps: a clip with no room for two ramps
  // and a hold should simply not be zoomed.
  it("drops a zoom that cannot fit rather than snapping it", () => {
    expect(zoomKeyframes(hold(0.5, 1.0) as never, 1.2).scale).toBeUndefined();
    expect(zoomKeyframes(hold(0.2, 0.4) as never, 0.8).scale).toBeUndefined();
  });

  it("still returns to full frame at the end", () => {
    const kf = zoomKeyframes(hold(2.42, 3.52) as never, 3.685);
    const s = kf.scale!;
    expect(s[s.length - 1]!.value).toBeCloseTo(1, 6);
    expect(s[s.length - 1]!.t).toBeLessThanOrEqual(3.685 + 1e-9);
  });

  it("keeps the zoom inside the clip it belongs to", () => {
    const kf = zoomKeyframes(hold(2.42, 3.52) as never, 3.685);
    for (const arr of Object.values(kf)) {
      for (const k of arr) {
        expect(k.t).toBeGreaterThanOrEqual(0);
        expect(k.t).toBeLessThanOrEqual(3.685 + 1e-9);
      }
    }
  });
});

describe("the frame never leaves the footage", () => {
  /*
   * "Never go out of the screen." The earlier version of this checked pan
   * targets that had headroom left, so the clamp itself was never exercised —
   * an overshoot had somewhere safe to go. These sit the pan exactly ON the
   * limit, which is where a zoom that leaves the footage actually happens, and
   * run the real recording's own segments at a spread of clip lengths.
   */
  const canvas = { width: 1920, height: 1080 };
  const covers = (kf: Record<string, Keyframe[]>, duration: number, label: string) => {
    for (let t = 0; t <= duration; t += 0.01) {
      const s = kf.scale?.length ? kfValue(kf.scale, t) : 1;
      const x = kf.x?.length ? kfValue(kf.x, t) : 0;
      const y = kf.y?.length ? kfValue(kf.y, t) : 0;
      // Below full frame the clip is smaller than the canvas; past the bound
      // its own edge comes inside it. Either shows the background.
      expect(s, `${label} scale @${t.toFixed(2)}`).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(Math.abs(x), `${label} x @${t.toFixed(2)}`).toBeLessThanOrEqual((canvas.width * (s - 1)) / 2 + 1e-6);
      expect(Math.abs(y), `${label} y @${t.toFixed(2)}`).toBeLessThanOrEqual((canvas.height * (s - 1)) / 2 + 1e-6);
    }
  };

  it("holds with the pan sitting exactly on the clamp limit", () => {
    for (const scale of [1.2, 1.6, 2.4]) {
      // The furthest a clip at this scale can pan before its edge shows.
      const bx = (canvas.width * (scale - 1)) / 2;
      const by = (canvas.height * (scale - 1)) / 2;
      const kf = zoomKeyframes(
        [
          { start: 2, end: 3.5, scale, x: bx, y: -by, ramp: 0.9, ease: "springOut" },
          { start: 4.2, end: 5.6, scale, x: -bx, y: by, ramp: 0.9, ease: "springOut" },
        ] as never,
        9
      );
      covers(kf, 9, `scale ${scale}`);
    }
  });

  it("holds for a zoom pressed against either end of the clip", () => {
    const bx = (canvas.width * 0.6) / 2;
    covers(zoomKeyframes([{ start: 0, end: 1, scale: 1.6, x: bx, y: 0, ramp: 0.9, ease: "springOut" }] as never, 4), 4, "at start");
    covers(zoomKeyframes([{ start: 3, end: 4, scale: 1.6, x: bx, y: 0, ramp: 0.9, ease: "springOut" }] as never, 4), 4, "at end");
  });
});

describe("camera speed", () => {
  /** Fastest instantaneous |dx/dt| of a keyframed property, sampled at 100Hz. */
  const maxSpeed = (keys: Keyframe[], to: number) => {
    let max = 0;
    let prev = kfValue(keys, 0);
    for (let t = 0.01; t <= to; t += 0.01) {
      const v = kfValue(keys, t);
      max = Math.max(max, Math.abs(v - prev) / 0.01);
      prev = v;
    }
    return max;
  };

  /*
   * A pan between holds used to take whatever gap the user's clicks happened to
   * leave — 672 canvas pixels in a tenth of a second was a legal outcome, and
   * it read as the camera being yanked. With adaptSpeed the holds each give up
   * a slice of dwell so the pan can respect the speed cap.
   */
  it("caps pan speed by borrowing time from the holds around it", () => {
    const holds = [
      { start: 2, end: 3, scale: 1.35, x: 336, y: 0, ramp: 0.9, ease: "springOut" },
      { start: 3.1, end: 4.2, scale: 1.35, x: -336, y: 0, ramp: 0.9, ease: "springOut" },
    ] as never;
    const cap = MAX_CAM_SPEED * canvas.width;
    // The guard guards something: without adaptation this pan really is a yank.
    expect(maxSpeed(zoomKeyframes(holds, 8, canvas).x!, 8)).toBeGreaterThan(cap * 1.5);
    expect(maxSpeed(zoomKeyframes(holds, 8, canvas, true).x!, 8)).toBeLessThanOrEqual(cap * 1.05);
  });

  it("never adapts hand-placed stops — the panel round-trip stays exact", () => {
    // Two stops close enough in time that adaptation WOULD move their edges.
    const stops: ZoomStop[] = [
      stop({ start: 2, end: 3, rect: { x: 0, y: 0, w: 960, h: 540 } }),
      stop({ start: 3.1, end: 4.2, rect: { x: 960, y: 540, w: 960, h: 540 } }),
    ];
    const got = readZoomStops(applyZoomStops(undefined, stops, 8, canvas), canvas);
    expect(got).toHaveLength(2);
    got.forEach((g, i) => {
      expect(g.start).toBeCloseTo(stops[i].start, 3);
      expect(g.end).toBeCloseTo(stops[i].end, 3);
    });
  });

  /*
   * Follow-path points are joined LINEARLY. The points come from a spring
   * simulation whose samples already carry the acceleration; easing between
   * them re-adds a stop at every keyframe — a visible stop-go pulse, which is
   * the exact defect the spring replaced.
   */
  it("joins drift points without stopping at each one", () => {
    const kf = zoomKeyframes(
      [
        {
          start: 1,
          end: 6,
          scale: 1.5,
          x: 0,
          y: 0,
          ramp: 0.9,
          ease: "springOut",
          path: [
            { t: 2, x: 100, y: 0 },
            { t: 3, x: 200, y: 0 },
            { t: 4, x: 300, y: 0 },
          ],
        },
      ] as never,
      8
    );
    // A steady 100px/s drift should stay near 100px/s throughout — an eased
    // join dips to ~0 at every point.
    let min = Infinity;
    for (let t = 2.2; t <= 3.8; t += 0.01) {
      min = Math.min(min, Math.abs(kfValue(kf.x!, t + 0.01) - kfValue(kf.x!, t)) / 0.01);
    }
    expect(min).toBeGreaterThan(60);
  });
});

describe("contentBox", () => {
  // Twins with render's TestContentFracGolden — the same geometry must come out
  // of both languages or preview and export place things differently.
  it("matches the renderer's golden numbers", () => {
    const cb = contentBox({ width: 1440, height: 1080 }, canvas);
    expect(cb.x0 / canvas.width).toBeCloseTo(0.125, 9);
    expect((cb.x1 - cb.x0) / canvas.width).toBeCloseTo(0.75, 9);
    expect(cb.y0).toBe(0);
    expect(cb.y1).toBe(canvas.height);
    expect(cb.k).toBe(1);
    const wide = contentBox({ width: 1920, height: 800 }, canvas);
    expect(wide.x0).toBe(0);
    expect(wide.y0 / canvas.height).toBeCloseTo(0.12963, 4);
    expect((wide.y1 - wide.y0) / canvas.height).toBeCloseTo(0.74074, 4);
  });

  it("degenerates to the full canvas when the source is unknown", () => {
    const cb = contentBox({ width: 0, height: 0 }, canvas);
    expect(cb).toEqual({ x0: 0, x1: canvas.width, y0: 0, y1: canvas.height, k: 1 });
  });
});
