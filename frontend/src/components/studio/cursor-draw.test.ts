import { describe, it, expect } from "vitest";
import { cursorAt, clickTimes, drawCursorFX, smoothSamples, withAlpha } from "./cursor-draw";
import { clicksInStep } from "../../clickAudio";
import type { CursorSample, CursorSidecar } from "../../cursor";
import type { Clip } from "../../types";

// These mirror Go (render.Track.At, ClickTimes, smoothPath). Where the preview
// and the export disagree about *where* the cursor is, editing lies to you —
// so the shapes are pinned here even though the drawing itself is approximate.

describe("cursorAt", () => {
  const s: CursorSample[] = [
    { t: 0, x: 0, y: 0 },
    { t: 1000, x: 100, y: 200 },
  ];

  it("holds the end values outside the recorded range", () => {
    expect(cursorAt(s, -5)).toEqual({ x: 0, y: 0 });
    expect(cursorAt(s, 99)).toEqual({ x: 100, y: 200 });
  });

  it("interpolates between samples", () => {
    expect(cursorAt(s, 0.5)).toEqual({ x: 50, y: 100 });
    expect(cursorAt(s, 0.25)).toEqual({ x: 25, y: 50 });
  });

  it("has no answer for an empty track", () => {
    expect(cursorAt([], 1)).toBeNull();
  });

  // The sampler can emit two samples at the same instant; dividing by a zero
  // span would poison the position with NaN for the rest of the draw.
  it("survives duplicate timestamps", () => {
    const dup: CursorSample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 0, x: 10, y: 10 },
      { t: 100, x: 20, y: 20 },
    ];
    const got = cursorAt(dup, 0.05)!;
    expect(Number.isFinite(got.x)).toBe(true);
    expect(Number.isFinite(got.y)).toBe(true);
  });
});

describe("clickTimes", () => {
  it("fires on press edges only", () => {
    const s: CursorSample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 100, x: 0, y: 0, down: 1 },
      { t: 200, x: 0, y: 0, down: 1 },
      { t: 300, x: 0, y: 0 },
      { t: 400, x: 0, y: 0, down: 2 },
    ];
    expect(clickTimes(s)).toEqual([0.1, 0.4]);
  });
});

describe("smoothSamples", () => {
  it("is a no-op when off", () => {
    const s: CursorSample[] = [
      { t: 0, x: 1, y: 1 },
      { t: 16, x: 9, y: 9 },
      { t: 32, x: 2, y: 2 },
    ];
    expect(smoothSamples(s, 0)).toBe(s);
  });

  it("reduces jitter", () => {
    const s: CursorSample[] = [];
    for (let i = 0; i < 60; i++) {
      s.push({ t: i * 16, x: 100 + i * 4 + (i % 2 === 0 ? 14 : 0), y: 200 });
    }
    const out = smoothSamples(s, 1);
    const rough = (a: CursorSample[]) => {
      let sum = 0;
      for (let i = 2; i < a.length; i++) sum += Math.abs(a[i].x - 2 * a[i - 1].x + a[i - 2].x);
      return sum;
    };
    expect(rough(out)).toBeLessThan(rough(s) * 0.5);
  });

  // Same rule the renderer enforces: a click is a claim about a pixel.
  it("leaves clicks exactly where they landed", () => {
    const s: CursorSample[] = [];
    for (let i = 0; i < 60; i++) {
      s.push({ t: i * 16, x: 100 + i * 10, y: 200, ...(i === 30 ? { down: 1 } : {}) });
    }
    const out = smoothSamples(s, 1);
    expect(out[30].x).toBe(s[30].x);
    expect(out[30].y).toBe(s[30].y);
  });
});

describe("withAlpha", () => {
  it("expands both hex forms", () => {
    expect(withAlpha("#ff0000", 1)).toBe("rgba(255,0,0,1)");
    expect(withAlpha("#f00", 0.5)).toBe("rgba(255,0,0,0.5)");
    expect(withAlpha("ffcc33", 0)).toBe("rgba(255,204,51,0)");
  });

  it("clamps alpha and falls back on nonsense rather than emitting invalid css", () => {
    expect(withAlpha("#fff", 5)).toBe("rgba(255,255,255,1)");
    expect(withAlpha("nope", 1)).toBe("rgba(255,204,51,1)");
  });
});

// Golden values shared with the Go renderer (backend/internal/render/
// golden_test.go asserts the identical numbers). The preview and the export are
// separate implementations of the same maths; these are what catch one drifting
// from the other, which would make the editor quietly lie about the render.
function goldenSamples(): CursorSample[] {
  const out: CursorSample[] = [];
  for (let i = 0; i < 20; i++) {
    const s: CursorSample = { t: i * 16, x: 100 + i * 7 + (i % 2 === 0 ? 5 : 0), y: 200 - i * 3 };
    if (i === 12) s.down = 1;
    out.push(s);
  }
  return out;
}

describe("parity with the Go renderer", () => {
  it("smooths to the same pixels", () => {
    const out = smoothSamples(goldenSamples(), 0.7);
    for (const [i, x, y] of [
      [0, 124, 190],
      [5, 140, 183],
      [10, 174, 170],
      [15, 203, 155],
      [19, 221, 148],
    ] as const) {
      expect([out[i].x, out[i].y], `sample ${i}`).toEqual([x, y]);
    }
  });

  it("interpolates to the same pixels", () => {
    const s = goldenSamples();
    for (const [t, x, y] of [
      [0.05, 122, 191],
      [0.12, 155, 178],
      [0.25, 212, 154],
    ] as const) {
      expect(cursorAt(s, t), `t=${t}`).toEqual({ x, y });
    }
  });
});

// A recording stub for the 2D context: enough surface for the draw path, and it
// remembers what was asked of it.
function stubCtx(w = 1920, h = 1080) {
  const calls: string[] = [];
  const rec = (name: string) => (...a: unknown[]) => {
    calls.push(`${name}(${a.map((v) => (typeof v === "number" ? Math.round(v) : v)).join(",")})`);
  };
  const grad = { addColorStop: rec("addColorStop") };
  const ctx = {
    canvas: { width: w, height: h },
    save: rec("save"),
    restore: rec("restore"),
    beginPath: rec("beginPath"),
    closePath: rec("closePath"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    arc: rec("arc"),
    fill: rec("fill"),
    stroke: rec("stroke"),
    fillRect: rec("fillRect"),
    createRadialGradient: (...a: unknown[]) => {
      calls.push(`createRadialGradient(${a.map((v) => Math.round(v as number)).join(",")})`);
      return grad;
    },
    set fillStyle(v: unknown) { calls.push(`fillStyle=${v}`); },
    set strokeStyle(v: unknown) { calls.push(`strokeStyle=${v}`); },
    set lineWidth(v: number) { calls.push(`lineWidth=${Math.round(v)}`); },
    set globalAlpha(v: number) { calls.push(`globalAlpha=${v}`); },
    set globalCompositeOperation(v: string) { calls.push(`gco=${v}`); },
    set lineJoin(v: string) { calls.push(`lineJoin=${v}`); },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const trackFor = (over: Partial<CursorSidecar> = {}): CursorSidecar => ({
  version: 1,
  video: { width: 1920, height: 1080 },
  clicks: true,
  samples: [
    { t: 0, x: 960, y: 540 },
    { t: 1000, x: 960, y: 540, down: 1 },
    { t: 2000, x: 960, y: 540 },
  ],
  ...over,
});

const clipFor = (cursor: Clip["cursor"]): Clip =>
  ({ id: "c", assetId: "a", start: 0, in: 0, out: 3, volume: 1,
     transform: { x: 0, y: 0, scale: 1, opacity: 1 }, cursor }) as Clip;

const FULL_BOX = { left: 0, top: 0, vw: 1920, vh: 1080 };

describe("drawCursorFX", () => {
  it("draws nothing when the clip has no effects", () => {
    const { ctx, calls } = stubCtx();
    drawCursorFX(ctx, clipFor(undefined), trackFor(), FULL_BOX, 0.5, 1);
    expect(calls).toHaveLength(0);
  });

  it("draws each enabled effect and nothing else", () => {
    const { ctx, calls } = stubCtx();
    drawCursorFX(ctx, clipFor({ highlight: {} }), trackFor(), FULL_BOX, 0.5, 1);
    const s = calls.join(" ");
    expect(s).toContain("createRadialGradient");
    expect(s).toContain("arc(960,540");   // centred on the pointer
    expect(s).not.toContain("fillRect");  // no spotlight was asked for
  });

  it("dims the whole frame for a spotlight, then erases a hole", () => {
    const { ctx, calls } = stubCtx();
    drawCursorFX(ctx, clipFor({ spotlight: {} }), trackFor(), FULL_BOX, 0.5, 1);
    const s = calls.join(" ");
    expect(s).toContain("fillRect(0,0,1920,1080)");
    expect(s).toContain("gco=destination-out");
  });

  // The rule the renderer enforces, mirrored: never draw a second cursor over a
  // recording that already contains one.
  it("only draws the pointer when Studio owns the cursor", () => {
    const baked = stubCtx();
    drawCursorFX(baked.ctx, clipFor({ pointer: {} }), trackFor({ hidden: false }), FULL_BOX, 0.5, 1);
    expect(baked.calls.join(" ")).not.toContain("lineJoin");

    const owned = stubCtx();
    drawCursorFX(owned.ctx, clipFor({ pointer: {} }), trackFor({ hidden: true }), FULL_BOX, 0.5, 1);
    expect(owned.calls.join(" ")).toContain("lineJoin=round"); // the arrow path
  });

  it("shows click ring at clip-local time when trim-in is set", () => {
    const clip = { ...clipFor({ clicks: {} }), in: 1, out: 4 };
    const track = trackFor({
      samples: [
        { t: 1000, x: 960, y: 540, down: 1 },
        { t: 1100, x: 960, y: 540 },
      ],
    });
    const atClick = stubCtx();
    drawCursorFX(atClick.ctx, clip, track, FULL_BOX, 0, 1);
    expect(atClick.calls.join(" ")).toContain("stroke(");

    const past = stubCtx();
    drawCursorFX(past.ctx, clip, track, FULL_BOX, 1.05, 1);
    expect(past.calls.join(" ")).not.toContain("stroke(");
  });

  it("shows a click ring only inside its window", () => {
    const during = stubCtx();
    drawCursorFX(during.ctx, clipFor({ clicks: {} }), trackFor(), FULL_BOX, 1.1, 1);
    expect(during.calls.join(" ")).toContain("stroke(");

    const after = stubCtx();
    drawCursorFX(after.ctx, clipFor({ clicks: {} }), trackFor(), FULL_BOX, 2.5, 1);
    expect(after.calls.join(" ")).not.toContain("stroke(");
  });

  // The bug the export had: overlays must ride the clip's box, not sit in fixed
  // canvas space.
  it("follows the clip's box when it is zoomed and panned", () => {
    const { ctx, calls } = stubCtx();
    // Clip drawn at 2x, shifted left — the centred pointer should land at
    // left + 0.5*vw = -400 + 1920 = 1520.
    drawCursorFX(ctx, clipFor({ highlight: {} }), trackFor(), { left: -400, top: -540, vw: 3840, vh: 2160 }, 0.5, 1);
    expect(calls.join(" ")).toContain("arc(1520,540");
  });
});

// Preview click playback. The guards matter more than the sound: scrubbing
// backwards or jumping must not replay everything in between.
describe("clicksInStep", () => {
  const times = [1.0, 2.0, 3.0];

  it("takes the clicks a normal playback tick crossed", () => {
    expect(clicksInStep(times, 0.9, 1.05)).toEqual([1.0]);
    expect(clicksInStep(times, 1.9, 2.05)).toEqual([2.0]);
  });

  it("takes nothing when the playhead did not move or went backwards", () => {
    expect(clicksInStep(times, 2.0, 2.0)).toEqual([]);
    expect(clicksInStep(times, 3.0, 0.5)).toEqual([]);
  });

  // Seeking across the timeline crosses every click in between; firing them all
  // at once is a burst of noise, not feedback.
  it("takes nothing across a jump", () => {
    expect(clicksInStep(times, 0, 5)).toEqual([]);
  });

  it("is half-open, so a click never fires twice on consecutive ticks", () => {
    expect(clicksInStep(times, 0.9, 1.0)).toEqual([1.0]);
    expect(clicksInStep(times, 1.0, 1.1)).toEqual([]);
  });
});
