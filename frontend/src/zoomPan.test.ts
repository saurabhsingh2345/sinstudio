import { describe, it, expect } from "vitest";
import {
  DEFAULT_EASE,
  MAX_ZOOM,
  applyZoomStops,
  clampRect,
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
import { kfValue } from "./components/studio/preview-engine";

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
