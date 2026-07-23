import { describe, it, expect } from "vitest";
import type { Clip, EditDoc } from "./types";
import { clipPlayDur } from "./types";
import { rippleCutTrackClips, timelineGaps } from "./rippleCut";

describe("rippleCutTrackClips", () => {
  const base: Clip = {
    id: "c1",
    assetId: "a1",
    start: 0,
    in: 0,
    out: 10,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    volume: 1,
  };

  it("shifts clips entirely after the cut", () => {
    const c2 = { ...base, id: "c2", start: 8 };
    const out = rippleCutTrackClips([c2], 2, 4, () => "new");
    expect(out[0].start).toBe(6);
  });

  it("removes a clip fully inside the cut", () => {
    const c2 = { ...base, id: "c2", start: 2, out: 3 };
    const out = rippleCutTrackClips([c2], 1, 5, () => "new");
    expect(out).toHaveLength(0);
  });

  it("splits a clip spanning the cut", () => {
    const out = rippleCutTrackClips([base], 3, 5, () => "c2");
    expect(out).toHaveLength(2);
    expect(out[0].out).toBeCloseTo(3, 1);
    expect(out[1].start).toBe(3);
    expect(out[1].in).toBeCloseTo(5, 1);
    expect(clipPlayDur(out[0]) + clipPlayDur(out[1])).toBeCloseTo(8, 1);
  });
});

describe("timelineGaps", () => {
  it("finds gap between clips", () => {
    const doc: EditDoc = {
      id: "p1",
      name: "test",
      version: 1,
      canvas: { width: 1920, height: 1080, fps: 30 },
      assets: [],
      tracks: [
        {
          id: "v1",
          kind: "video",
          clips: [
            {
              id: "c1",
              assetId: "a1",
              start: 0,
              in: 0,
              out: 5,
              transform: { x: 0, y: 0, scale: 1, opacity: 1 },
              volume: 1,
            },
            {
              id: "c2",
              assetId: "a2",
              start: 8,
              in: 0,
              out: 4,
              transform: { x: 0, y: 0, scale: 1, opacity: 1 },
              volume: 1,
            },
          ],
        },
      ],
    };
    const gaps = timelineGaps(doc, 2);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].start).toBe(5);
    expect(gaps[0].end).toBe(8);
  });
});
