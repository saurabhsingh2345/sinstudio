import { describe, it, expect } from "vitest";
import { SILENCE_DEFAULTS, cutClipSilences, detectSilences, planSilenceCuts } from "./silence";
import type { Clip } from "./types";

// 10s of peaks at 10 samples/sec: loud except where `quiet` says.
const peaksWith = (quiet: [number, number][]) => {
  const p = new Array(100).fill(0.5);
  for (const [a, b] of quiet) for (let i = Math.round(a * 10); i < Math.round(b * 10); i++) p[i] = 0.01;
  return p;
};

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: "c1",
    assetId: "a",
    start: 5,
    in: 0,
    out: 10,
    transform: { scale: 1, x: 0, y: 0, opacity: 1 },
    volume: 1,
    ...over,
  }) as Clip;

describe("detectSilences", () => {
  it("finds a quiet stretch and pads both ends", () => {
    const got = detectSilences(peaksWith([[3, 5]]), 10, SILENCE_DEFAULTS);
    expect(got).toHaveLength(1);
    // Padded in by 120ms per side, so audible content keeps its attacks.
    expect(got[0].start).toBeCloseTo(3.12, 2);
    expect(got[0].end).toBeCloseTo(4.88, 2);
  });

  it("leaves breaths alone", () => {
    // 0.5s is pacing, not dead air (0.6 minSilence + padding).
    expect(detectSilences(peaksWith([[3, 3.5]]), 10, SILENCE_DEFAULTS)).toEqual([]);
  });

  it("catches silence running to the end of the asset", () => {
    const got = detectSilences(peaksWith([[8, 10]]), 10, SILENCE_DEFAULTS);
    expect(got).toHaveLength(1);
    expect(got[0].end).toBeGreaterThan(9.5);
  });

  it("no waveform, no opinions", () => {
    expect(detectSilences([], 10)).toEqual([]);
    expect(detectSilences([0.5], 0)).toEqual([]);
  });
});

describe("planSilenceCuts", () => {
  it("keeps the speech around a pause", () => {
    const plan = planSilenceCuts(clip(), [{ start: 3, end: 5 }]);
    expect(plan!.kept).toEqual([
      { in: 0, out: 3 },
      { in: 5, out: 10 },
    ]);
    expect(plan!.removed).toBeCloseTo(2, 3);
  });

  it("ignores silences outside the clip's trim", () => {
    const plan = planSilenceCuts(clip({ in: 6, out: 10 }), [{ start: 0, end: 4 }]);
    expect(plan).toBeNull(); // the pause was already trimmed away
  });

  it("quotes saved time in play seconds at the clip's speed", () => {
    const plan = planSilenceCuts(clip({ speed: 2 }), [{ start: 3, end: 5 }]);
    expect(plan!.removed).toBeCloseTo(1, 3); // 2 source-secs at 2x
  });

  it("declines a cut that saves nothing worth having", () => {
    expect(planSilenceCuts(clip(), [{ start: 3, end: 3.05 }])).toBeNull();
  });
});

describe("cutClipSilences", () => {
  const mkId = (() => {
    let n = 0;
    return () => `new_${++n}`;
  })();

  it("lays segments back to back with no hole where the pause was", () => {
    const plan = planSilenceCuts(clip(), [{ start: 3, end: 5 }])!;
    const segs = cutClipSilences(clip(), plan, mkId);
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(5);
    expect(segs[0].out).toBe(3);
    // The second segment starts exactly where the first ends — jump cut.
    expect(segs[1].start).toBeCloseTo(8, 3);
    expect(segs[1].in).toBe(5);
    expect(segs[0].id).toBe("c1"); // the first keeps the identity (selection survives)
    expect(segs[1].id).not.toBe("c1");
  });

  it("shifts keyframes per segment, the way the razor does", () => {
    const c = clip({
      keyframes: { scale: [{ t: 1, value: 1.5 }, { t: 7, value: 2 }] },
    });
    const plan = planSilenceCuts(c, [{ start: 3, end: 5 }])!;
    const segs = cutClipSilences(c, plan, mkId);
    expect(segs[0].keyframes!.scale.map((k) => k.t)).toEqual([1, 7]);
    // Second segment starts at source 5 → local shift of 5s.
    expect(segs[1].keyframes!.scale.map((k) => k.t)).toEqual([2]);
  });

  it("keeps fades and transitions only on the outer edges", () => {
    const c = clip({ fadeIn: 0.5, fadeOut: 0.5, transitionIn: { type: "fade", duration: 0.3 }, hold: 1 });
    const plan = planSilenceCuts(c, [{ start: 3, end: 5 }])!;
    const segs = cutClipSilences(c, plan, mkId);
    expect(segs[0].fadeIn).toBe(0.5);
    expect(segs[0].fadeOut).toBe(0);
    expect(segs[0].hold).toBe(0);
    expect(segs[1].fadeIn).toBe(0);
    expect(segs[1].fadeOut).toBe(0.5);
    expect(segs[1].hold).toBe(1);
    expect(segs[0].transitionIn).toBeDefined();
    expect(segs[1].transitionIn).toBeUndefined();
  });
});
