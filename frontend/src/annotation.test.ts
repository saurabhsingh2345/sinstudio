import { describe, it, expect } from "vitest";
import {
  ANNO_KINDS,
  arrowHead,
  clampAnno,
  isArrow,
  newAnnotation,
  normRect,
  resolveAnno,
} from "./annotation";
import type { Annotation } from "./types";

describe("resolveAnno", () => {
  // The renderer cannot tell an omitted JSON field from a zero one, so it treats
  // 0 as "unset" for thickness and opacity. The preview has to agree or every
  // freshly-typed 0 would look invisible in one and default in the other.
  it("treats zero as unset the way the renderer does", () => {
    const a = resolveAnno({ kind: "box", x: 0, y: 0, thickness: 0, opacity: 0 });
    expect(a.thickness).toBe(6);
    expect(a.opacity).toBe(1);
  });

  it("keeps values that were actually chosen", () => {
    const a = resolveAnno({ kind: "box", x: 0, y: 0, thickness: 12, opacity: 0.4, color: "#ff0000" });
    expect(a).toMatchObject({ thickness: 12, opacity: 0.4, color: "#ff0000" });
  });

  it("defaults a hollow shape to no fill", () => {
    expect(resolveAnno({ kind: "box", x: 0, y: 0 }).fill).toBe("");
  });
});

describe("newAnnotation", () => {
  it("gives every kind something visible on screen", () => {
    for (const { kind } of ANNO_KINDS) {
      const a = newAnnotation(kind);
      expect(a.kind).toBe(kind);
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1);
      if (isArrow(a)) {
        // An arrow that starts zero-length draws nothing, so it would appear
        // not to have been added at all.
        expect(Math.hypot((a.x2 ?? 0) - a.x, (a.y2 ?? 0) - a.y)).toBeGreaterThan(0.05);
      } else {
        expect(a.w).toBeGreaterThan(0.02);
        expect(a.h).toBeGreaterThan(0.02);
      }
    }
  });

  it("gives the labelled kinds text to show", () => {
    expect(newAnnotation("number").text).toBeTruthy();
    expect(newAnnotation("text").text).toBeTruthy();
  });
});

describe("arrowHead", () => {
  // The twin of arrowHead() in annotation.go. If these drift the preview points
  // somewhere the export doesn't.
  it("puts the tip exactly on the target", () => {
    const h = arrowHead(0, 0, 100, 0, 10)!;
    expect(h.points[0]).toEqual([100, 0]);
  });

  it("stops the shaft short so it does not poke through the tip", () => {
    const h = arrowHead(0, 0, 100, 0, 10)!;
    expect(h.stopX).toBeLessThan(100);
    expect(h.stopX).toBeGreaterThan(60); // but still most of the way there
  });

  it("makes the head wider than the shaft", () => {
    const t = 10;
    const h = arrowHead(0, 0, 100, 0, t)!;
    const spread = Math.abs(h.points[1][1] - h.points[2][1]);
    expect(spread).toBeGreaterThan(t * 2);
  });

  // The SAME numbers are asserted in backend/internal/render/annotation_test.go
  // (TestArrowGeometryGolden). The preview and the export build the arrow
  // independently; these values are the only thing keeping them pointing at the
  // same place.
  it("agrees with the Go renderer, to the number", () => {
    const h = arrowHead(0, 0, 100, 0, 10)!;
    expect(h.points).toEqual([
      [100, 0],
      [66, 15.5],
      [66, -15.5],
    ]);
    expect(h.stopX).toBeCloseTo(71.1, 9);
    expect(h.stopY).toBeCloseTo(0, 9);
  });

  it("refuses a zero-length arrow rather than dividing by zero", () => {
    expect(arrowHead(50, 50, 50, 50, 10)).toBeNull();
  });

  it("never builds a head longer than the arrow itself", () => {
    // A very short, very thick arrow would otherwise turn inside out.
    const h = arrowHead(0, 0, 5, 0, 40)!;
    const baseX = (h.points[1][0] + h.points[2][0]) / 2;
    expect(baseX).toBeGreaterThanOrEqual(-0.001);
  });

  it("points correctly in every direction", () => {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
    ]) {
      const h = arrowHead(100, 100, 100 + dx * 80, 100 + dy * 80, 8)!;
      const [tipX, tipY] = h.points[0];
      const baseX = (h.points[1][0] + h.points[2][0]) / 2;
      const baseY = (h.points[1][1] + h.points[2][1]) / 2;
      // The head's base sits behind the tip, along the arrow's own direction.
      expect((tipX - baseX) * dx + (tipY - baseY) * dy).toBeGreaterThan(0);
    }
  });
});

describe("normRect", () => {
  it("turns a rectangle dragged up-left into a positive one", () => {
    expect(normRect(100, 100, -40, -30)).toEqual({ x: 60, y: 70, w: 40, h: 30 });
  });

  it("leaves an already-positive rectangle alone", () => {
    expect(normRect(10, 20, 30, 40)).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});

describe("clampAnno", () => {
  // A callout dragged off the canvas isn't rejected by the renderer — it just
  // silently draws nothing, which reads as the annotation having been deleted.
  it("keeps an arrow's ends on the canvas", () => {
    const a = clampAnno({ kind: "arrow", x: -3, y: 0.5, x2: 4, y2: -2 });
    expect(a.x).toBe(0);
    expect(a.x2).toBe(1);
    expect(a.y2).toBe(0);
  });

  it("keeps part of a box on screen without forcing it to fit", () => {
    const big: Annotation = { kind: "box", x: 5, y: 5, w: 2, h: 2 };
    const a = clampAnno(big);
    expect(a.x).toBeLessThanOrEqual(1);
    expect(a.y).toBeLessThanOrEqual(1);
    // Deliberately not shrunk: a callout may be larger than the frame.
    expect(a.w).toBe(2);
  });

  it("leaves a shape that is already on screen untouched", () => {
    const a: Annotation = { kind: "box", x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(clampAnno(a)).toEqual(a);
  });
});
