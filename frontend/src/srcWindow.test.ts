import { describe, expect, it } from "vitest";
import { splitSrcWindow, srcWindow } from "./types";
import type { Clip } from "./types";

/*
 * A split half is its own video.
 *
 * Razor a 60s file at 30s and you have two clips. Dragging the left one's end
 * used to keep serving footage from 30s onward — the file had the frames, so the
 * trim handed them over — which put the same frames on the timeline twice and
 * meant the freeze-frame that belongs at the half's own end never appeared.
 * srcIn/srcOut are what make each half answer for itself.
 */

const clip = (p: Partial<Clip> = {}): Clip =>
  ({ id: "c", assetId: "a", start: 0, in: 0, out: 10, transform: { x: 0, y: 0, scale: 1, opacity: 1 }, volume: 1, ...p }) as Clip;
const asset = (duration: number) => ({ duration });

describe("srcWindow", () => {
  it("is the whole asset for a clip that was never split", () => {
    expect(srcWindow(clip(), asset(60))).toEqual([0, 60]);
  });

  it("honours a recorded boundary", () => {
    expect(srcWindow(clip({ srcOut: 30 }), asset(60))).toEqual([0, 30]);
    expect(srcWindow(clip({ srcIn: 30 }), asset(60))).toEqual([30, 60]);
    expect(srcWindow(clip({ srcIn: 10, srcOut: 20 }), asset(60))).toEqual([10, 20]);
  });

  it("never lets a boundary exceed the file", () => {
    expect(srcWindow(clip({ srcOut: 999 }), asset(60))).toEqual([0, 60]);
  });

  it("stays unbounded when the duration is unknown", () => {
    expect(srcWindow(clip(), undefined)).toEqual([0, Infinity]);
    expect(srcWindow(clip(), asset(0))).toEqual([0, Infinity]);
  });

  it("never returns an inverted window", () => {
    const [lo, hi] = srcWindow(clip({ srcIn: 50, srcOut: 10 }), asset(60));
    expect(hi).toBeGreaterThanOrEqual(lo);
  });
});

describe("splitSrcWindow", () => {
  it("gives each half its own end of the file", () => {
    const { left, right } = splitSrcWindow(clip(), 30);
    expect(srcWindow({ ...left }, asset(60))).toEqual([0, 30]);
    expect(srcWindow({ ...right }, asset(60))).toEqual([30, 60]);
  });

  it("composes, so splitting a half again cannot hand footage back", () => {
    // Split at 30, then split the left half at 15.
    const first = splitSrcWindow(clip(), 30);
    const second = splitSrcWindow(first.left, 15);
    expect(srcWindow({ ...second.left }, asset(60))).toEqual([0, 15]);
    expect(srcWindow({ ...second.right }, asset(60))).toEqual([15, 30]);
    // The inner-right half must NOT reach past 30 just because the file does.
    expect(srcWindow({ ...second.right }, asset(60))[1]).toBe(30);
  });

  it("keeps the right half of a right half bounded below", () => {
    const first = splitSrcWindow(clip(), 30);
    const second = splitSrcWindow(first.right, 45);
    expect(srcWindow({ ...second.left }, asset(60))).toEqual([30, 45]);
    expect(srcWindow({ ...second.right }, asset(60))).toEqual([45, 60]);
  });
});

describe("what the trim then does with it", () => {
  // Mirrors Timeline's out-drag: play is capped by the window, the rest freezes.
  const trimOut = (c: Clip, a: { duration: number }, desiredPlay: number) => {
    const sp = c.speed && c.speed > 0 ? c.speed : 1;
    const [, hi] = srcWindow(c, a);
    const maxSrcPlay = (hi - c.in) / sp;
    const play = Math.min(desiredPlay, maxSrcPlay);
    return { out: c.in + play * sp, hold: Math.max(0, desiredPlay - play) };
  };

  it("freezes at the half's own end instead of eating the sibling", () => {
    const left = clip({ in: 0, out: 30, srcOut: 30 });
    // Ask for 40s of a half that only owns 30.
    expect(trimOut(left, asset(60), 40)).toEqual({ out: 30, hold: 10 });
  });

  it("still hands over real footage when nothing was split", () => {
    const whole = clip({ in: 0, out: 30 });
    expect(trimOut(whole, asset(60), 40)).toEqual({ out: 40, hold: 0 });
  });

  it("lets a trimmed half be pulled back to its own boundary first", () => {
    // Trimmed to 20 of its 30; asking for 25 gives real footage, not a freeze.
    const left = clip({ in: 0, out: 20, srcOut: 30 });
    expect(trimOut(left, asset(60), 25)).toEqual({ out: 25, hold: 0 });
  });
});
