import { arrowHead, resolveAnno } from "../../annotation";
import type { Annotation } from "../../types";

// The preview twin of backend/internal/render/annotation.go.
//
// Shapes are SVG in a canvas-sized viewBox, so every number here is the same
// canvas pixel the Go renderer computes with and the two cannot drift through a
// unit conversion. Text is HTML rather than SVG because it has to wrap, and
// wrapping SVG text means measuring glyphs by hand — the same reason the title
// preview is HTML.

/** Alpha the renderer applies to a highlight so the frame reads through it. */
const HIGHLIGHT_ALPHA = 0.45;

export function AnnotationLayer({
  anno,
  width,
  height,
}: {
  anno: Annotation;
  /** The clip's box on the preview stage, in screen px. */
  width: number;
  height: number;
}) {
  const a = resolveAnno(anno);
  // Draw in canvas space and let the viewBox scale it, so a callout authored at
  // 1080p lands identically on a stage of any size.
  const W = 1920;
  const H = 1080;
  const ref = H / 1080;
  const t = a.thickness * ref;

  const x0 = a.x * W;
  const y0 = a.y * H;
  const bw = a.w * W;
  const bh = a.h * H;
  const cx = x0 + bw / 2;
  const cy = y0 + bh / 2;

  const shape = () => {
    switch (a.kind) {
      case "arrow": {
        const head = arrowHead(x0, y0, a.x2 * W, a.y2 * H, t);
        if (!head) return null;
        return (
          <g fill={a.color} stroke={a.color} opacity={a.opacity}>
            <line x1={x0} y1={y0} x2={head.stopX} y2={head.stopY} strokeWidth={t} strokeLinecap="round" />
            <polygon points={head.points.map((p) => p.join(",")).join(" ")} stroke="none" />
          </g>
        );
      }
      case "box":
        return (
          <rect
            x={x0}
            y={y0}
            width={bw}
            height={bh}
            rx={a.radius * ref}
            fill={a.fill || "none"}
            stroke={a.color}
            strokeWidth={t}
            opacity={a.opacity}
          />
        );
      case "ellipse":
        return (
          <ellipse
            cx={cx}
            cy={cy}
            rx={bw / 2}
            ry={bh / 2}
            fill={a.fill || "none"}
            stroke={a.color}
            strokeWidth={t}
            opacity={a.opacity}
          />
        );
      case "highlight":
        return (
          <rect
            x={x0}
            y={y0}
            width={bw}
            height={bh}
            rx={a.radius * ref}
            fill={a.fill || a.color}
            opacity={a.opacity * HIGHLIGHT_ALPHA}
          />
        );
      case "number": {
        const r = Math.min(bw, bh) / 2;
        return <circle cx={cx} cy={cy} r={r} fill={a.fill || a.color} opacity={a.opacity} />;
      }
      case "text":
        return (
          <rect
            x={x0}
            y={y0}
            width={bw}
            height={bh}
            rx={(a.radius || 14) * ref}
            fill={a.fill || a.color}
            opacity={a.opacity}
          />
        );
      default:
        return null;
    }
  };

  // Label sizes mirror the renderer's fallbacks: a badge's digits are sized off
  // the disc, a callout's text has a fixed default.
  const label = () => {
    if (a.kind !== "number" && a.kind !== "text") return null;
    if (!a.text.trim()) return null;
    const size =
      a.textSize > 0
        ? a.textSize * ref
        : a.kind === "number"
          ? (Math.min(bw, bh) / 2) * 1.1
          : 34 * ref;
    return (
      <div
        style={{
          position: "absolute",
          left: `${(x0 / W) * 100}%`,
          top: `${(y0 / H) * 100}%`,
          width: `${(bw / W) * 100}%`,
          height: `${(bh / H) * 100}%`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          color: a.textColor,
          // The stage is scaled from the canvas, so convert canvas px to the
          // stage's own px before handing the size to the browser.
          fontSize: (size / H) * height,
          lineHeight: 1.3,
          padding: "0 4%",
          opacity: a.opacity,
          whiteSpace: "pre-wrap",
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        {a.text}
      </div>
    );
  };

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      >
        {shape()}
      </svg>
      {label()}
    </div>
  );
}
