import { describe, it, expect } from "vitest";
import { clipBox, kfValue } from "./components/studio/preview-engine";
import { anchorFrac, type Clip, type Transform } from "./types";
import { buildMotionPreset, MOTION_PRESETS } from "./motionPresets";

// The canvas the export would use; clipBox is given the same numbers for stage
// and canvas here so on-stage px == canvas px and the assertions read directly.
const W = 640;
const H = 360;

function clip(tr: Partial<Transform>, keyframes?: Clip["keyframes"]): Clip {
  return {
    id: "c1",
    assetId: "a",
    start: 0,
    in: 0,
    out: 4,
    transform: { x: 0, y: 0, scale: 1, opacity: 1, ...tr },
    volume: 1,
    keyframes,
  } as Clip;
}

const boxAt = (c: Clip, t: number) => clipBox(c, t, W, H, W, H);

describe("anchorFrac", () => {
  it("treats the zero value as centered so pre-anchor documents don't move", () => {
    expect(anchorFrac({ x: 0, y: 0, scale: 1, opacity: 1 })).toEqual([0.5, 0.5]);
  });

  it("maps ±0.5 to the edges and clamps beyond", () => {
    const t = (ax: number, ay: number): Transform => ({ x: 0, y: 0, scale: 1, opacity: 1, anchorX: ax, anchorY: ay });
    expect(anchorFrac(t(-0.5, 0.5))).toEqual([0, 1]);
    expect(anchorFrac(t(-9, 9))).toEqual([0, 1]);
  });
});

describe("clipBox anchoring", () => {
  it("centers a scaled clip by default", () => {
    const b = boxAt(clip({ scale: 0.5 }), 0);
    expect(b.left).toBe((W - W * 0.5) / 2);
    expect(b.top).toBe((H - H * 0.5) / 2);
  });

  it("pins the box to the corner for a top-left anchor", () => {
    const b = boxAt(clip({ scale: 0.5, anchorX: -0.5, anchorY: -0.5 }), 0);
    expect(b.left).toBe(0);
    expect(b.top).toBe(0);
  });

  // The property that makes an anchor useful: whatever sits under the anchor
  // must not drift as the clip scales, because that point is what the viewer
  // is being asked to look at.
  it("holds the anchored point fixed across a zoom", () => {
    const anchorX = 0.25; // right of center
    const anchorY = -0.1;
    const [ax, ay] = anchorFrac({ x: 0, y: 0, scale: 1, opacity: 1, anchorX, anchorY });
    const c = clip({ scale: 1, anchorX, anchorY }, {
      scale: [
        { t: 0, value: 1, ease: "linear" },
        { t: 4, value: 3 },
      ],
    });
    // Stage position of the anchored point = box origin + anchor fraction × box size.
    const stagePoint = (t: number) => {
      const b = boxAt(c, t);
      return [b.left + ax * b.vw, b.top + ay * b.vh];
    };
    const [x0, y0] = stagePoint(0);
    for (const t of [1, 2, 3, 3.99]) {
      const [x, y] = stagePoint(t);
      expect(x).toBeCloseTo(x0, 6);
      expect(y).toBeCloseTo(y0, 6);
    }
  });
});

describe("clipBox rotation", () => {
  it("falls back to the static transform when unkeyed", () => {
    expect(boxAt(clip({ rotation: 30 }), 1).rotation).toBe(30);
    expect(boxAt(clip({}), 1).rotation).toBe(0);
  });

  it("interpolates rotation keyframes and overrides the static value", () => {
    const c = clip({ rotation: 999 }, {
      rotation: [
        { t: 0, value: 0, ease: "linear" },
        { t: 4, value: 360 },
      ],
    });
    expect(boxAt(c, 0).rotation).toBe(0);
    expect(boxAt(c, 2).rotation).toBeCloseTo(180, 6);
    expect(boxAt(c, 4).rotation).toBeCloseTo(360, 6);
  });

  it("holds the end values outside the keyed range, like every other property", () => {
    const keys = [
      { t: 1, value: 10, ease: "linear" },
      { t: 2, value: 20 },
    ];
    expect(kfValue(keys, 0)).toBe(10);
    expect(kfValue(keys, 99)).toBe(20);
  });
});

describe("motion presets", () => {
  it("emits only keyable properties, ordered, within the clip", () => {
    const D = 5;
    for (const { id } of MOTION_PRESETS) {
      const kf = buildMotionPreset(id, D, W, H);
      expect(Object.keys(kf).length, `${id} should animate something`).toBeGreaterThan(0);
      for (const [prop, keys] of Object.entries(kf)) {
        expect(["x", "y", "scale", "rotation", "opacity"], `${id}.${prop}`).toContain(prop);
        expect(keys.length, `${id}.${prop}`).toBeGreaterThan(0);
        const times = keys.map((k) => k.t);
        expect(times, `${id}.${prop} times must be sorted`).toEqual([...times].sort((a, b) => a - b));
        expect(Math.min(...times), `${id}.${prop} starts at/after 0`).toBeGreaterThanOrEqual(0);
        expect(Math.max(...times), `${id}.${prop} ends within the clip`).toBeLessThanOrEqual(D);
      }
    }
  });

  it("keeps pans inside the frame they zoom into", () => {
    for (const id of ["panLeft", "panRight"] as const) {
      const kf = buildMotionPreset(id, 5, W, H);
      const s = kf.scale![0].value;
      const overhang = (W * s - W) / 2; // px of frame beyond the canvas per side
      for (const k of kf.x!) {
        expect(Math.abs(k.value), `${id} pans past the frame edge`).toBeLessThanOrEqual(overhang);
      }
    }
  });

  it("degrades to a sane duration rather than emitting negative times", () => {
    for (const { id } of MOTION_PRESETS) {
      const kf = buildMotionPreset(id, 0, W, H);
      for (const keys of Object.values(kf)) {
        for (const k of keys) expect(k.t, id).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
