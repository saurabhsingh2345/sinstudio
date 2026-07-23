import { describe, it, expect } from "vitest";
import { autoFrame } from "./autoFrame";
import { smartFocus } from "./smartFocus";
import { kfValue } from "./components/studio/preview-engine";
import realTrack from "./__fixtures__/recording.cursor.json";

/*
The ingest path, run against a REAL recording.

This fixture is the pointer sidecar of an actual 5-second screen capture made on
a Retina display — 68 samples, two presses, captured at 2072x1340. Everything
else about auto-framing is tested against synthetic tracks, which is fine for
the rules but proves nothing about the shape of real data: real samples are
irregularly spaced, carry a heartbeat while the pointer rests, start at a
non-zero timestamp, and come from a capture whose width is not the reference the
radii are quoted at. All four of those had to be right for this to produce
anything, and each was a place the earlier code went wrong.
*/

const track = realTrack as unknown as { samples: { t: number; x: number; y: number; down?: number }[]; video: { width: number; height: number } };
const canvas = { width: 1920, height: 1080 };

describe("autoFrame on a real recording", () => {
  it("frames the capture it was recorded from", () => {
    const r = autoFrame(
      { hasCursor: true, cursorHidden: false },
      {},
      track,
      3.685, // the clip's own trimmed length, as the timeline had it
      canvas
    );
    expect(r).not.toBeNull();
    // Two presses in five seconds: there is something to zoom on.
    expect(r!.zooms).toBeGreaterThan(0);
    expect(r!.patch.cursor?.clicks).toBeDefined();
  });

  it("writes a zoom that goes in and comes back to full frame", () => {
    const r = autoFrame({ hasCursor: true }, {}, track, 3.685, canvas)!;
    const scale = r.patch.keyframes!.scale!;
    expect(Math.max(...scale.map((k) => k.value))).toBeGreaterThan(1.2);
    expect(scale[0]!.value).toBeCloseTo(1, 6);
    expect(scale[scale.length - 1]!.value).toBeCloseTo(1, 6);
  });

  // The capture is 2072 wide, not the 1920 the radii are quoted at. Before the
  // radii were scaled this is exactly the recording that under-detected.
  it("handles a capture wider than the reference", () => {
    expect(track.video.width).toBeGreaterThan(1920);
    expect(autoFrame({ hasCursor: true }, {}, track, 3.685, canvas)!.zooms).toBeGreaterThan(0);
  });

  // Real tracks start at a non-zero timestamp and rest between moves; a zoom
  // must still land inside the clip rather than off the end of it.
  it("keeps every keyframe inside the clip", () => {
    const dur = 3.685;
    const r = autoFrame({ hasCursor: true }, {}, track, dur, canvas)!;
    for (const arr of Object.values(r.patch.keyframes!)) {
      for (const k of arr) {
        expect(k.t).toBeGreaterThanOrEqual(0);
        expect(k.t).toBeLessThanOrEqual(dur + 1e-6);
      }
    }
  });
});

/*
The same coverage guarantee, driven by the real recording's own focus segments
rather than hand-placed ones, across the clip lengths a recording actually gets
trimmed to. This is the "never go out of the screen" promise checked against
data nobody chose to make the test pass.
*/
describe("the real recording never uncovers the canvas", () => {
  const canvas = { width: 1920, height: 1080 };
  it.each([2.5, 3.685, 4.4, 5.11, 8, 12])("holds at a %ss clip", (dur) => {
    const { keyframes } = smartFocus(track as never, dur, canvas);
    if (!keyframes.scale?.length) return; // too short to zoom at all: fine
    for (let t = 0; t <= dur; t += 0.01) {
      const s = kfValue(keyframes.scale, t);
      const x = keyframes.x?.length ? kfValue(keyframes.x, t) : 0;
      const y = keyframes.y?.length ? kfValue(keyframes.y, t) : 0;
      expect(s).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(Math.abs(x)).toBeLessThanOrEqual((canvas.width * (s - 1)) / 2 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual((canvas.height * (s - 1)) / 2 + 1e-6);
    }
  });

  // The snap this whole phase exists to remove.
  it.each([3.685, 5.11, 12])("uses a full ramp at a %ss clip", (dur) => {
    const { keyframes } = smartFocus(track as never, dur, canvas);
    const s = keyframes.scale;
    if (!s) return;
    const moves = s
      .slice(1)
      .map((k, i) => ({ secs: k.t - s[i]!.t, dv: k.value - s[i]!.value }))
      .filter((g) => Math.abs(g.dv) > 1e-9);
    for (const m of moves) expect(m.secs).toBeGreaterThan(0.5);
  });
});
