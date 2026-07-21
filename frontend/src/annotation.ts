import type { Annotation, AnnoKind } from "./types";

// Annotation geometry and defaults, shared by the live preview and the clip
// editor. This is the twin of backend/internal/render/annotation.go: the
// renderer fills in the same defaults, and the arrow is built from the same
// numbers, so what the preview draws is what the export draws.
//
// Everything positional is a canvas fraction (0..1). Thickness and text sizes
// are px at a 1080-tall reference, matching every other size in the schema.

export const ANNO_KINDS: { kind: AnnoKind; label: string }[] = [
  { kind: "arrow", label: "Arrow" },
  { kind: "box", label: "Box" },
  { kind: "ellipse", label: "Ellipse" },
  { kind: "highlight", label: "Highlight" },
  { kind: "number", label: "Step number" },
  { kind: "text", label: "Callout" },
];

export const ANNO_COLOR = "#f5a524";

/** Defaults the renderer applies, made explicit so the preview can agree. */
export interface ResolvedAnno {
  kind: AnnoKind;
  x: number;
  y: number;
  w: number;
  h: number;
  x2: number;
  y2: number;
  color: string;
  fill: string;
  thickness: number;
  opacity: number;
  radius: number;
  text: string;
  textSize: number;
  textColor: string;
}

export function resolveAnno(a: Annotation): ResolvedAnno {
  return {
    kind: a.kind,
    x: a.x,
    y: a.y,
    w: a.w ?? 0,
    h: a.h ?? 0,
    x2: a.x2 ?? 0,
    y2: a.y2 ?? 0,
    color: a.color || ANNO_COLOR,
    fill: a.fill || "",
    // 0 means unset, not invisible — same rule as the renderer, which cannot
    // tell an omitted field from a zero one in JSON.
    thickness: a.thickness || 6,
    opacity: a.opacity && a.opacity > 0 ? a.opacity : 1,
    radius: a.radius ?? 0,
    text: a.text ?? "",
    textSize: a.textSize ?? 0,
    textColor: a.textColor || "#ffffff",
  };
}

/** A new callout, placed somewhere visible and sized to be grabbable. */
export function newAnnotation(kind: AnnoKind): Annotation {
  const base: Annotation = { kind, x: 0.3, y: 0.35, color: ANNO_COLOR, thickness: 6, opacity: 1 };
  switch (kind) {
    case "arrow":
      return { ...base, x: 0.25, y: 0.6, x2: 0.5, y2: 0.4, thickness: 10 };
    case "box":
      return { ...base, w: 0.3, h: 0.25, radius: 12 };
    case "ellipse":
      return { ...base, w: 0.3, h: 0.25 };
    case "highlight":
      return { ...base, y: 0.45, w: 0.3, h: 0.08, radius: 6, color: "#fde047" };
    case "number":
      return { ...base, x: 0.45, y: 0.42, w: 0.1, h: 0.18, fill: "#ef4444", text: "1" };
    case "text":
      return {
        ...base,
        x: 0.3,
        y: 0.4,
        w: 0.4,
        h: 0.16,
        radius: 14,
        fill: "#1e293b",
        text: "Click here",
        textSize: 34,
      };
  }
}

/** The box kinds are placed by a rectangle; the arrow by two points. */
export const isArrow = (a: Annotation) => a.kind === "arrow";

/**
 * The arrowhead triangle and the point the shaft stops at.
 *
 * Mirrors arrowHead() in annotation.go — including shortening the shaft to 85%
 * of the head so it does not poke through the tip, and capping the head at the
 * arrow's own length so a very short arrow is all head rather than inside out.
 *
 * Works in whatever units it is given; the caller passes canvas pixels.
 */
export function arrowHead(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  t: number
): { points: [number, number][]; stopX: number; stopY: number } | null {
  const dx = bx - ax;
  const dy = by - ay;
  const l = Math.hypot(dx, dy);
  if (l === 0) return null;
  const ux = dx / l;
  const uy = dy / l;
  const head = Math.min(t * 3.4, l);
  const half = t * 1.55;
  const baseX = bx - ux * head;
  const baseY = by - uy * head;
  const px = -uy;
  const py = ux;
  return {
    points: [
      [bx, by],
      [baseX + px * half, baseY + py * half],
      [baseX - px * half, baseY - py * half],
    ],
    stopX: bx - ux * head * 0.85,
    stopY: by - uy * head * 0.85,
  };
}

/** Normalize a rectangle dragged in any direction to positive width/height. */
export function normRect(x: number, y: number, w: number, h: number) {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Keep a callout on screen.
 *
 * A shape dragged off the canvas is not an error the renderer will complain
 * about — it just silently draws nothing, which reads as the annotation having
 * been deleted. Clamping the anchor while allowing the size through means a
 * callout can still be bigger than the frame if that's what was asked for.
 */
export function clampAnno(a: Annotation): Annotation {
  if (isArrow(a)) {
    return { ...a, x: clamp01(a.x), y: clamp01(a.y), x2: clamp01(a.x2 ?? 0), y2: clamp01(a.y2 ?? 0) };
  }
  const w = a.w ?? 0;
  const h = a.h ?? 0;
  return { ...a, x: Math.max(-w + 0.02, Math.min(1 - 0.02, a.x)), y: Math.max(-h + 0.02, Math.min(1 - 0.02, a.y)) };
}
