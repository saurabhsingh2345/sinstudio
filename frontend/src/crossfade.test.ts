import { describe, expect, it } from "vitest";
import { clipCover, crossClip, planCrossfades } from "./crossfade";
import { activeVisuals, upcomingVisuals } from "./components/studio/preview-engine";
import type { Clip, Track, TrackKind } from "./types";

const clip = (id: string, start: number, len: number, extra: Partial<Clip> = {}): Clip =>
  ({
    id,
    assetId: id,
    start,
    in: 0,
    out: len,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    volume: 1,
    ...extra,
  }) as Clip;

const lane = (kind: TrackKind, ...clips: Clip[]): Track[] => [{ id: "t", kind, clips } as Track];

// These mirror backend/internal/render/crossfade_test.go case for case: the
// preview and the export have to agree about what a transition is against.
describe("planCrossfades", () => {
  it("holds the outgoing scene under the next clip's transition", () => {
    const a = clip("a", 0, 5);
    const b = clip("b", 5, 5, { transitionIn: { type: "fade", duration: 0.35 } });
    const plan = planCrossfades(lane("video", a, b));
    expect(clipCover(a, plan)).toBe(0.35);
    expect(clipCover(b, plan)).toBe(0);
    expect(crossClip(b, plan).transitionIn).toEqual({ type: "fade", duration: 0.35 });
  });

  it("reads one joint from either side: a transition out becomes the dissolve in", () => {
    const a = clip("a", 0, 5, { transitionOut: { type: "dissolve", duration: 0.4 } });
    const b = clip("b", 5, 5);
    const plan = planCrossfades(lane("video", a, b));
    expect(crossClip(a, plan).transitionOut).toBeUndefined();
    expect(clipCover(a, plan)).toBe(0.4);
    expect(crossClip(b, plan).transitionIn).toEqual({ type: "dissolve", duration: 0.4 });
  });

  it("freezes only what an existing overlap does not already cover", () => {
    const a = clip("a", 0, 5);
    const long = clip("b", 4.8, 5, { transitionIn: { type: "dissolve", duration: 0.5 } });
    expect(clipCover(a, planCrossfades(lane("video", a, long)))).toBeCloseTo(0.3, 9);
    const short = clip("b", 4.8, 5, { transitionIn: { type: "dissolve", duration: 0.1 } });
    expect(clipCover(a, planCrossfades(lane("video", a, short)))).toBe(0);
  });

  it("leaves a fade across a gap fading into the canvas", () => {
    const a = clip("a", 0, 5, { transitionOut: { type: "fade", duration: 0.35 } });
    const b = clip("b", 6, 5, { transitionIn: { type: "fade", duration: 0.35 } });
    const plan = planCrossfades(lane("video", a, b));
    expect(clipCover(a, plan)).toBe(0);
    expect(crossClip(a, plan).transitionOut).toEqual({ type: "fade", duration: 0.35 });
  });

  it("leaves overlay joints alone — they fade out to transparent already", () => {
    const a = clip("a", 0, 5, { transitionOut: { type: "fade", duration: 0.35 } });
    const b = clip("b", 5, 5, { transitionIn: { type: "fade", duration: 0.35 } });
    expect(planCrossfades(lane("overlay", a, b)).size).toBe(0);
  });

  it("keeps a deliberate fadeOut's hole to the background", () => {
    const a = clip("a", 0, 5, { fadeOut: 0.5 });
    const b = clip("b", 5, 5, { transitionIn: { type: "fade", duration: 0.5 } });
    expect(clipCover(a, planCrossfades(lane("video", a, b)))).toBe(0);
  });

  it("never holds a scene past the clip it introduces", () => {
    const a = clip("a", 0, 5);
    const b = clip("b", 5, 0.2, { transitionIn: { type: "fade", duration: 2 } });
    expect(clipCover(a, planCrossfades(lane("video", a, b)))).toBe(0.2);
  });

  it("does not hold a clip that is painted over its successor", () => {
    const a = clip("a", 0, 5, { z: 5 });
    const b = clip("b", 5, 5, { z: 1, transitionIn: { type: "fade", duration: 0.35 } });
    expect(clipCover(a, planCrossfades(lane("video", a, b)))).toBe(0);
  });
});

describe("activeVisuals with joints", () => {
  it("keeps the outgoing clip on stage, opaque, for the transition", () => {
    const a = clip("a", 0, 5, { transitionOut: { type: "fade", duration: 0.4 } });
    const b = clip("b", 5, 5);
    const tracks = lane("video", a, b);

    // Mid-transition: both scenes are up, and the one underneath has not been
    // faded down — that fade is what used to show the canvas colour.
    const at = activeVisuals(tracks, 5.2);
    expect(at.map((x) => x.clip.id)).toEqual(["a", "b"]);
    expect(at[0].clip.transitionOut).toBeUndefined();

    // Past the transition it is gone, and it never outlives its cover.
    expect(activeVisuals(tracks, 5.5).map((x) => x.clip.id)).toEqual(["b"]);
  });

  it("leaves a lone clip's own end alone", () => {
    const tracks = lane("video", clip("a", 0, 5, { transitionOut: { type: "fade", duration: 0.4 } }));
    expect(activeVisuals(tracks, 4.9).map((x) => x.clip.id)).toEqual(["a"]);
    expect(activeVisuals(tracks, 5.1)).toEqual([]);
  });
});

describe("upcomingVisuals", () => {
  it("lists clips due within the window and nothing already on stage", () => {
    const tracks = lane("video", clip("a", 0, 5), clip("b", 5, 5), clip("c", 10, 5));
    expect(upcomingVisuals(tracks, 4, 2).map((x) => x.clip.id)).toEqual(["b"]);
    expect(upcomingVisuals(tracks, 1, 2).map((x) => x.clip.id)).toEqual([]);
    expect(upcomingVisuals(tracks, 4, 8).map((x) => x.clip.id)).toEqual(["b", "c"]);
  });
});
