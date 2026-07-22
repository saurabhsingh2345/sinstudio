import { describe, it, expect } from "vitest";
import { IDLE_DEFAULTS, applySpeedup, detectIdle, planSpeedup } from "./idle";
import { kfValue } from "./components/studio/preview-engine";
import type { CursorSample } from "./cursor";
import type { Clip } from "./types";

// A 20s session: pointer works for 5s, parks for 8s, works again.
const session = (): CursorSample[] => {
  const out: CursorSample[] = [];
  for (let t = 0; t < 5000; t += 100) out.push({ t, x: 200 + (t / 100) * 20, y: 300 });
  for (let t = 5000; t <= 13000; t += 250) out.push({ t, x: 1200, y: 300 });
  for (let t = 13250; t <= 20000; t += 100) out.push({ t, x: 1200 - ((t - 13000) / 100) * 15, y: 300 });
  return out;
};

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: "c1",
    assetId: "a",
    start: 2,
    in: 0,
    out: 20,
    transform: { scale: 1, x: 0, y: 0, opacity: 1 },
    volume: 1,
    ...over,
  }) as Clip;

describe("detectIdle", () => {
  it("finds the parked stretch, margins subtracted", () => {
    const got = detectIdle(session(), 1920, null, 20);
    expect(got).toHaveLength(1);
    // The park starts at 5s, but the slow tail of the preceding motion sits
    // inside the radius, so the run legitimately anchors a touch earlier.
    expect(got[0].start).toBeGreaterThan(4.9);
    expect(got[0].start).toBeLessThan(5.5);
    // Same at the far end: the outbound motion re-crosses the anchor's radius.
    expect(got[0].end).toBeGreaterThan(12.4);
    expect(got[0].end).toBeLessThan(13.4);
  });

  it("a click breaks the idleness", () => {
    const s = session();
    const mid = s.findIndex((p) => p.t >= 9000);
    s[mid] = { ...s[mid], down: 1 };
    const got = detectIdle(s, 1920, null, 20);
    // The park splits around the click; neither half plus margins reaches 8s.
    for (const span of got) expect(span.end - span.start).toBeLessThan(8);
  });

  it("talking vetoes an idle stretch", () => {
    // Loud audio across the whole session: nothing is idle.
    const peaks = new Array(200).fill(0.5);
    expect(detectIdle(session(), 1920, peaks, 20)).toEqual([]);
  });

  it("quiet audio does not veto", () => {
    const peaks = new Array(200).fill(0.005);
    expect(detectIdle(session(), 1920, peaks, 20)).toHaveLength(1);
  });

  it("scales the radius to the capture", () => {
    // Wiggle of ±60px around the park: idle on a 4K capture (radius scales
    // up), not on a 1920 one.
    const s = session().map((p) => (p.t >= 5000 && p.t <= 13000 ? { ...p, x: p.x + (p.t % 500 === 0 ? 60 : 0) } : p));
    expect(detectIdle(s, 1920, null, 20)).toHaveLength(0);
    expect(detectIdle(s, 3840, null, 20)).toHaveLength(1);
  });
});

describe("planSpeedup / applySpeedup", () => {
  const idles = [{ start: 5.3, end: 12.7 }];

  it("quotes the time saved at the factor", () => {
    const plan = planSpeedup(clip(), idles, 4)!;
    // 7.4s of idle at 4x plays in 1.85s: saves 5.55.
    expect(plan.saved).toBeCloseTo(5.55, 2);
    expect(plan.segments.map((s) => s.fast)).toEqual([false, true, false]);
  });

  it("lays segments back to back with the idle one sped up", () => {
    const plan = planSpeedup(clip(), idles, 4)!;
    const segs = applySpeedup(clip(), plan, 4, () => "n1");
    expect(segs).toHaveLength(3);
    expect(segs[0].speed).toBeUndefined();
    expect(segs[1].speed).toBeCloseTo(4, 4);
    expect(segs[2].speed).toBeUndefined();
    // Continuity: each next start = previous start + previous play time.
    expect(segs[1].start).toBeCloseTo(2 + 5.3, 3);
    expect(segs[2].start).toBeCloseTo(2 + 5.3 + 7.4 / 4, 3);
  });

  it("keeps a zoom in flight continuous across the splice", () => {
    const c = clip({
      keyframes: { scale: [{ t: 2, value: 1 }, { t: 10, value: 2 }] },
    });
    const plan = planSpeedup(c, idles, 4)!;
    const segs = applySpeedup(c, plan, 4, () => "n2");
    // Value at the end of segment 0 must equal the value at the start of
    // segment 1 — the boundary was sampled, not snapped.
    const endOf0 = kfValue(segs[0].keyframes!.scale, 5.3);
    const startOf1 = kfValue(segs[1].keyframes!.scale, 0);
    expect(endOf0).toBeCloseTo(startOf1, 3);
    // And the original mid-flight value at source 5.3s is preserved.
    expect(startOf1).toBeCloseTo(1 + ((5.3 - 2) / 8) * 1, 1);
  });

  it("declines when nothing meaningful is saved", () => {
    expect(planSpeedup(clip(), [{ start: 5, end: 5.2 }], 4)).toBeNull();
    expect(planSpeedup(clip(), idles, 1)).toBeNull();
  });
});

describe("defaults", () => {
  it("margin keeps normal speed around the edges of an idle span", () => {
    const got = detectIdle(session(), 1920, null, 20, { ...IDLE_DEFAULTS, margin: 1 });
    const base = detectIdle(session(), 1920, null, 20)[0];
    // A larger margin strictly shrinks the same span from both ends.
    expect(got[0].start).toBeCloseTo(base.start + 0.7, 3);
    expect(got[0].end).toBeCloseTo(base.end - 0.7, 3);
  });
});
