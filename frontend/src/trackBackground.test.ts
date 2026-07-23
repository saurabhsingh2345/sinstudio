import { describe, it, expect } from "vitest";
import { trackBackgroundCSS } from "./trackBackground";
import type { Track } from "./types";

describe("trackBackgroundCSS", () => {
  it("returns solid color when no gradient end", () => {
    expect(trackBackgroundCSS({ id: "t", kind: "background", backgroundColor: "#112233" })).toBe("#112233");
  });

  it("returns vertical gradient when backgroundColor2 is set", () => {
    const t: Track = { id: "t", kind: "background", backgroundColor: "#111", backgroundColor2: "#222" };
    expect(trackBackgroundCSS(t)).toBe("linear-gradient(180deg, #111, #222)");
  });

  it("uses fallback when track is missing", () => {
    expect(trackBackgroundCSS(undefined, "#abc")).toBe("#abc");
  });
});
