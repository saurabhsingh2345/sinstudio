import { describe, it, expect } from "vitest";
import { planReframe, reframeSummary, wouldLetterbox } from "./reframe";
import type { CursorSidecar } from "./cursor";
import type { EditDoc } from "./types";

const LANDSCAPE = { width: 1920, height: 1080 };
const VERTICAL = { width: 1080, height: 1920 };

const clip = (over: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    assetId: "a1",
    start: 0,
    in: 0,
    out: 6,
    volume: 1,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    ...over,
  }) as never;

const docWith = (clips: unknown[], assets: unknown[]): EditDoc =>
  ({
    id: "p1",
    name: "p",
    version: 1,
    canvas: { ...LANDSCAPE, fps: 30 },
    assets,
    tracks: [{ id: "t1", kind: "video", name: "V", clips }],
  }) as never;

// A pointer that dwells on the right of the frame, so the camera has something
// to find and somewhere distinctive to put it.
const track = (): CursorSidecar => {
  const samples = [];
  for (let t = 0; t <= 6000; t += 100) {
    samples.push({ t, x: t < 3000 ? 1500 : 1520, y: t < 3000 ? 800 : 810 });
  }
  return { version: 1, video: { width: 1920, height: 1080 }, clicks: true, hidden: true, samples };
};

describe("wouldLetterbox", () => {
  it("is true when the shapes differ", () => {
    expect(wouldLetterbox({ width: 1920, height: 1080 }, VERTICAL)).toBe(true);
    expect(wouldLetterbox({ width: 1080, height: 1920 }, LANDSCAPE)).toBe(true);
  });

  it("is false when they match, within the renderer's own tolerance", () => {
    expect(wouldLetterbox({ width: 1920, height: 1080 }, LANDSCAPE)).toBe(false);
    expect(wouldLetterbox({ width: 1918, height: 1080 }, LANDSCAPE)).toBe(false);
  });

  // An asset whose dimensions never arrived must not be cropped on a guess.
  it("is false when the source size is unknown", () => {
    expect(wouldLetterbox(undefined, VERTICAL)).toBe(false);
    expect(wouldLetterbox({ width: 0, height: 0 }, VERTICAL)).toBe(false);
  });
});

describe("planReframe", () => {
  const assets = [{ id: "a1", width: 1920, height: 1080, hasCursor: true }];

  it("fills a clip that would otherwise letterbox", () => {
    const plan = planReframe(docWith([clip()], assets), VERTICAL, () => null);
    expect(plan.filled).toBe(1);
    expect(plan.patches[0].patch.fit).toBe("fill");
  });

  it("leaves a clip that already matches the new frame alone", () => {
    const plan = planReframe(docWith([clip()], assets), LANDSCAPE, () => null);
    expect(plan.filled).toBe(0);
    expect(plan.patches).toHaveLength(0);
  });

  // The whole point: a 9:16 frame has far less width to spare, so the camera is
  // a different camera — not the landscape one stretched.
  it("recomputes the camera against the new frame", () => {
    const land = planReframe(docWith([clip()], assets), LANDSCAPE, () => track());
    const vert = planReframe(docWith([clip()], assets), VERTICAL, () => track());
    expect(land.refocused).toBe(1);
    expect(vert.refocused).toBe(1);
    expect(vert.patches[0].patch.keyframes).not.toEqual(land.patches[0].patch.keyframes);
  });

  // A pan computed for 16:9 that survives into 9:16 is a move through a frame it
  // was never computed for, so the old camera is removed rather than merged over.
  it("drops the old camera instead of merging over it", () => {
    const stale = clip({
      keyframes: {
        scale: [{ t: 0, value: 1 }, { t: 5, value: 2 }],
        x: [{ t: 0, value: 0 }, { t: 5, value: -400 }],
        y: [{ t: 0, value: 0 }, { t: 5, value: -99 }],
        opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }],
      },
    });
    const plan = planReframe(docWith([stale], assets), VERTICAL, () => track());
    const kf = plan.patches[0].patch.keyframes!;
    expect(kf.x).not.toContainEqual({ t: 5, value: -400 });
    // Anything that is not the camera survives — a fade is not a framing choice.
    expect(kf.opacity).toEqual([{ t: 0, value: 0 }, { t: 1, value: 1 }]);
  });

  // The case a merge would survive: when the new frame yields NO camera at all,
  // a merged patch leaves the old scale/x/y in place and the clip keeps panning
  // through a frame that no longer exists. Replacing is the only version that
  // clears them, so this is the test that distinguishes the two.
  it("clears the old camera even when the new frame finds none", () => {
    const restless: CursorSidecar = {
      version: 1,
      video: { width: 1920, height: 1080 },
      clicks: true,
      hidden: true,
      // Sweeping continuously: never dwells, so there is nothing to zoom to.
      samples: Array.from({ length: 61 }, (_, i) => ({ t: i * 100, x: i * 30, y: 540 })),
    };
    const stale = clip({
      keyframes: {
        scale: [{ t: 0, value: 1 }, { t: 5, value: 2 }],
        x: [{ t: 0, value: 0 }, { t: 5, value: -400 }],
      },
    });
    const plan = planReframe(docWith([stale], assets), VERTICAL, () => restless);
    const kf = plan.patches[0].patch.keyframes!;
    expect(kf.scale).toBeUndefined();
    expect(kf.x).toBeUndefined();
  });

  it("leaves titles and callouts alone — they are drawn at canvas size already", () => {
    const doc = docWith(
      [clip({ id: "t", assetId: "", title: { text: "hi" } }), clip({ id: "n", assetId: "", annotation: { kind: "box" } })],
      assets
    );
    expect(planReframe(doc, VERTICAL, () => null).patches).toHaveLength(0);
  });

  // A bubble fills its own circle and a device frame fits the picture into its
  // screen; telling either to fill crops the thing it is built around.
  it("does not fill a webcam bubble or a device frame", () => {
    const doc = docWith([clip({ id: "b", bubble: {} }), clip({ id: "d", device: { kind: "phone" } })], assets);
    const plan = planReframe(doc, VERTICAL, () => null);
    expect(plan.filled).toBe(0);
  });

  it("still fills a clip whose sidecar could not be fetched", () => {
    const plan = planReframe(docWith([clip()], assets), VERTICAL, () => undefined);
    expect(plan.refocused).toBe(0);
    expect(plan.filled).toBe(1);
  });

  it("ignores audio and caption tracks", () => {
    const doc = docWith([clip()], assets);
    doc.tracks[0].kind = "audio";
    expect(planReframe(doc, VERTICAL, () => track()).patches).toHaveLength(0);
  });
});

describe("reframeSummary", () => {
  it("says nothing when only the frame changed", () => {
    expect(reframeSummary({ patches: [], refocused: 0, filled: 0 })).toBeNull();
  });

  it("counts both kinds of change", () => {
    expect(reframeSummary({ patches: [], refocused: 2, filled: 1 })).toBe(
      "2 clips re-framed, 1 filled to the new frame"
    );
  });
});
