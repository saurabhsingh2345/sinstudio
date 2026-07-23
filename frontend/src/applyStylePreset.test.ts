import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyStylePreset } from "./applyStylePreset";
import type { Asset, Clip } from "./types";
import { STYLE_PRESETS } from "./stylePresets";

vi.mock("./api", () => ({
  api: {
    cursorTrack: vi.fn().mockResolvedValue({
      track: {
        version: 1,
        video: { width: 1920, height: 1080 },
        samples: [
          { t: 1000, x: 0.5, y: 0.5, down: 1 },
          { t: 1100, x: 0.5, y: 0.5, down: 0 },
        ],
        clicks: true,
      },
    }),
  },
}));

describe("applyStylePreset", () => {
  const asset: Asset = {
    id: "a1",
    name: "screen.mp4",
    kind: "video",
    path: "p/a1.mp4",
    duration: 10,
    width: 1920,
    height: 1080,
    hasAlpha: false,
    hasCursor: true,
    cursorHidden: true,
    source: "recording-screen",
    createdAt: "2026-01-01T00:00:00Z",
  };

  const clip: Clip = {
    id: "c1",
    assetId: "a1",
    start: 0,
    in: 0,
    out: 10,
    transform: { x: 0, y: 0, scale: 1, opacity: 1 },
    volume: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies backdrop from preset", async () => {
    const updates: Partial<Clip>[] = [];
    const preset = STYLE_PRESETS.find((p) => p.id === "minimal")!;
    await applyStylePreset("proj", "t1", clip, asset, preset, { width: 1920, height: 1080 }, (_t, _c, patch) => {
      updates.push(patch);
    });
    expect(updates[0]?.backdrop?.color1).toBe("#334155");
  });

  it("keeps preset cursor FX when smartFocus re-runs (does not reset to autoFrame defaults)", async () => {
    const updates: Partial<Clip>[] = [];
    const preset = STYLE_PRESETS.find((p) => p.id === "product-demo")!;
    await applyStylePreset("proj", "t1", clip, asset, preset, { width: 1920, height: 1080 }, (_t, _c, patch) => {
      updates.push(patch);
    });
    const merged = updates[0];
    expect(merged?.cursor?.pointer?.smoothing).toBe(0.55);
    expect(merged?.cursor?.pointer?.style).toBe("arrow");
    expect(merged?.cursor?.clicks?.size).toBe(120);
    expect(merged?.motionBlur).toBe(0.45);
  });
});
