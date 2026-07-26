import { describe, expect, it } from "vitest";
import { restack, zOrder } from "./clipZ";
import { activeVisuals } from "./components/studio/preview-engine";
import type { Clip, Track } from "./types";

const clip = (id: string, z?: number): Clip =>
  ({ id, assetId: "a", start: 0, in: 0, out: 5, transform: { x: 0, y: 0, scale: 1, opacity: 1 }, volume: 1, ...(z === undefined ? {} : { z }) }) as Clip;

const ids = (cs: Clip[]) => zOrder(cs).map((c) => c.id).join(",");

describe("zOrder", () => {
  it("leaves a z-less track in its array order", () => {
    expect(ids([clip("a"), clip("b"), clip("c")])).toBe("a,b,c");
  });

  it("sorts by z, breaking ties on array position", () => {
    expect(ids([clip("a", 2), clip("b"), clip("c", 2)])).toBe("b,a,c");
  });
});

describe("restack", () => {
  it("brings a clip to the front and leaves it there when others move", () => {
    const cs = [clip("a"), clip("b"), clip("c")];
    expect(restack(cs, "a", "front")).toBe(true);
    expect(ids(cs)).toBe("b,c,a");
    // 'b' stepping forward must not vault over the front clip.
    restack(cs, "b", "forward");
    expect(ids(cs)).toBe("c,b,a");
  });

  it("sends to back, and one step is one step", () => {
    const cs = [clip("a"), clip("b"), clip("c")];
    restack(cs, "c", "back");
    expect(ids(cs)).toBe("c,a,b");
    restack(cs, "c", "forward");
    expect(ids(cs)).toBe("a,c,b");
    restack(cs, "c", "backward");
    expect(ids(cs)).toBe("c,a,b");
  });

  it("is a no-op at the ends, and on an unknown clip", () => {
    const cs = [clip("a"), clip("b")];
    expect(restack(cs, "a", "backward")).toBe(false);
    expect(restack(cs, "b", "forward")).toBe(false);
    expect(restack(cs, "nope", "front")).toBe(false);
    expect(ids(cs)).toBe("a,b");
  });

  it("renumbers z in place — the array itself never reorders", () => {
    const cs = [clip("a"), clip("b")];
    restack(cs, "a", "front");
    expect(cs.map((c) => c.id)).toEqual(["a", "b"]); // untouched: only z moved
    expect(cs.find((c) => c.id === "a")!.z).toBe(1);
    // z=0 is the omitempty default, so the bottom clip carries no z at all.
    expect("z" in cs.find((c) => c.id === "b")!).toBe(false);
  });

  it("gives a definite order even when every clip arrives with the same z", () => {
    const cs = [clip("a", 5), clip("b", 5), clip("c", 5)];
    restack(cs, "c", "back");
    expect(ids(cs)).toBe("c,a,b");
  });
});

describe("activeVisuals stacking", () => {
  const track = (id: string, kind: string, clips: Clip[]): Track => ({ id, kind, name: id, clips }) as Track;

  it("ranks track kind over clip z", () => {
    const tracks = [
      track("o", "overlay", [clip("logo", -99)]),
      track("v", "video", [clip("main", 99)]),
    ];
    expect(activeVisuals(tracks, 1).map((x) => x.clip.id)).toEqual(["main", "logo"]);
  });

  it("orders siblings of one track by z", () => {
    const tracks = [track("o", "overlay", [clip("logo", 2), clip("badge", 1)])];
    expect(activeVisuals(tracks, 1).map((x) => x.clip.id)).toEqual(["badge", "logo"]);
  });

  it("still falls back to document order without any z", () => {
    const tracks = [
      track("v", "video", [clip("main")]),
      track("o1", "overlay", [clip("first")]),
      track("o2", "overlay", [clip("second")]),
    ];
    expect(activeVisuals(tracks, 1).map((x) => x.clip.id)).toEqual(["main", "first", "second"]);
  });
});
