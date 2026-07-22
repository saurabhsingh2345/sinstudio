import type { CursorSample, CursorSidecar } from "../../cursor";
import type { Clip } from "../../types";
import { contentBox } from "../../zoomPan";

// Cursor effects, drawn live on the preview canvas.
//
// The export composites these as PNG overlays inside the filtergraph; there is
// no way to reuse that here, so this is a second implementation of the same
// pictures. Keep it in sync with backend/internal/render/cursorfx.go and
// cursordraw.go — the shapes, defaults and stacking order all mirror it.
//
// Approximate on purpose, in the same way the rest of the preview is: the
// export stays authoritative and the "render frame" button is how you check.
// What this has to get right is *where* things are and *when* they happen,
// because that is what you are editing.

export const HL_DEFAULTS = { size: 96, color: "#ffcc33", opacity: 0.35 };
export const CLICK_DEFAULTS = { size: 140, color: "#ffffff", duration: 0.45 };
export const SPOT_DEFAULTS = { radius: 220, dim: 0.55 };
export const PTR_DEFAULTS = { size: 44, color: "#ffffff", style: "arrow", opacity: 1 };

/** Mirrors cursor.Track.At — linear between samples, held at the ends. */
export function cursorAt(samples: CursorSample[], tSec: number): { x: number; y: number } | null {
  if (!samples.length) return null;
  const ms = tSec * 1000;
  if (ms <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (ms >= last.t) return { x: last.x, y: last.y };
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (ms < b.t) {
      const span = Math.max(1, b.t - a.t);
      const f = (ms - a.t) / span;
      // Truncated to match cursor.Track.At, which interpolates in ints.
      return { x: a.x + Math.trunc((b.x - a.x) * f), y: a.y + Math.trunc((b.y - a.y) * f) };
    }
  }
  return { x: last.x, y: last.y };
}

/** Press edges only — a held button is one click. Mirrors Track.ClickTimes. */
export function clickTimes(samples: CursorSample[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const s of samples) {
    const down = s.down ?? 0;
    if (down !== 0 && prev === 0) out.push(s.t / 1000);
    prev = down;
  }
  return out;
}

/**
 * Mirrors render.smoothPath: a time-weighted window, with clicks as anchors so
 * the cursor still passes through the pixel it actually clicked.
 */
export function smoothSamples(samples: CursorSample[], intensity: number): CursorSample[] {
  const n = samples.length;
  if (n < 3 || intensity <= 0) return samples;
  const window = Math.max(0, Math.min(1, intensity)) * 260;
  if (window < 1) return samples;
  const anchorMS = 220;

  const clicks: number[] = [];
  let prev = 0;
  for (const s of samples) {
    const d = s.down ?? 0;
    if (d !== 0 && prev === 0) clicks.push(s.t);
    prev = d;
  }
  const nearest = (t: number) => {
    let best = Infinity;
    for (const c of clicks) best = Math.min(best, Math.abs(t - c));
    return best;
  };

  const out = samples.map((s) => ({ ...s }));
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    let sx = 0;
    let sy = 0;
    let wsum = 0;
    for (let j = i; j >= 0; j--) {
      const d = s.t - samples[j].t;
      if (d > window) break;
      const w = 1 - d / window;
      sx += samples[j].x * w;
      sy += samples[j].y * w;
      wsum += w;
    }
    for (let j = i + 1; j < n; j++) {
      const d = samples[j].t - s.t;
      if (d > window) break;
      const w = 1 - d / window;
      sx += samples[j].x * w;
      sy += samples[j].y * w;
      wsum += w;
    }
    if (wsum <= 0) continue;
    let blend = 1;
    if (clicks.length) {
      const d = nearest(s.t);
      if (d < anchorMS) blend = d / anchorMS;
    }
    // Truncated to whole pixels because the Go side stores samples as ints and
    // does the same. Keeping sub-pixel precision here would be *better* in
    // isolation and wrong in context: the preview would sit up to a pixel off
    // the export, magnified by any zoom.
    out[i].x = Math.trunc(s.x * (1 - blend) + (sx / wsum) * blend);
    out[i].y = Math.trunc(s.y * (1 - blend) + (sy / wsum) * blend);
  }
  return out;
}

// The arrow outline from cursordraw.go, in a unit box with the tip at the origin.
const ARROW: [number, number][] = [
  [0.0, 0.0],
  [0.0, 1.0],
  [0.26, 0.75],
  [0.42, 1.12],
  [0.6, 1.04],
  [0.44, 0.68],
  [0.72, 0.66],
];

export interface CursorBox {
  /** The clip's drawn rectangle on the stage, in stage px. */
  left: number;
  top: number;
  vw: number;
  vh: number;
}

/**
 * Draw one clip's cursor effects.
 *
 * Everything is placed through the clip's own box, exactly as the export does
 * — the pointer lives in the recording's frame, and that frame moves and grows
 * with any zoom. `canvasScale` converts authored canvas px (effect sizes) into
 * stage px, so effects stay proportional at any preview size.
 */
export function drawCursorFX(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  track: CursorSidecar,
  box: CursorBox,
  localT: number,
  canvasScale: number
) {
  const fx = clip.cursor;
  if (!fx || !track.samples.length) return;

  const smoothing = fx.pointer?.smoothing ?? 0;
  const samples =
    fx.pointer && smoothing > 0 && track.hidden ? smoothSamples(track.samples, smoothing) : track.samples;

  const at = cursorAt(samples, localT);
  if (!at) return;

  const vw = track.video.width || 1;
  const vh = track.video.height || 1;
  /*
   * Where the picture sits inside the clip box. A recording whose shape is
   * not the canvas's is FITTED with bars (render.go's prefit; the preview's
   * object-fit), so "fraction of the video" and "fraction of the box" stop
   * being the same number. Mirrors cursorfx.go's contentFrac, tolerance and
   * all — below half a percent the export really does stretch, and the naive
   * fraction is the exact answer.
   */
  const stageW = Math.max(1, ctx.canvas.width);
  const stageH = Math.max(1, ctx.canvas.height);
  let fx0 = 0;
  let fy0 = 0;
  let cfw = 1;
  let cfh = 1;
  const canA = stageW / stageH;
  if (Math.abs(vw / vh - canA) / canA > 0.005) {
    const cb = contentBox({ width: vw, height: vh }, { width: stageW, height: stageH });
    fx0 = cb.x0 / stageW;
    fy0 = cb.y0 / stageH;
    cfw = (cb.x1 - cb.x0) / stageW;
    cfh = (cb.y1 - cb.y0) / stageH;
  }
  // Pointer position on the stage, via the clip's box.
  const px = box.left + (fx0 + (at.x / vw) * cfw) * box.vw;
  const py = box.top + (fy0 + (at.y / vh) * cfh) * box.vh;
  // How magnified the clip is, so effects grow with the content they mark.
  const zoom = box.vw / Math.max(1, ctx.canvas.width);
  const unit = canvasScale * zoom;

  ctx.save();

  // 1. Spotlight — dim everything, then punch a hole. Drawn first so the
  //    highlight and rings sit on top of the dim rather than under it.
  if (fx.spotlight) {
    const radius = (fx.spotlight.radius ?? SPOT_DEFAULTS.radius) * canvasScale;
    const dim = fx.spotlight.dim ?? SPOT_DEFAULTS.dim;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, dim))})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    // destination-out turns the gradient into an eraser, which is how the
    // mask's soft hole is reproduced without compositing a second layer.
    ctx.globalCompositeOperation = "destination-out";
    const g = ctx.createRadialGradient(px, py, 0, px, py, radius * 1.45);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(radius / (radius * 1.45), "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, radius * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 2. Highlight — a soft disc under the pointer.
  if (fx.highlight) {
    const r = ((fx.highlight.size ?? HL_DEFAULTS.size) / 2) * unit;
    const op = fx.highlight.opacity ?? HL_DEFAULTS.opacity;
    const col = fx.highlight.color ?? HL_DEFAULTS.color;
    const g = ctx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, withAlpha(col, op));
    g.addColorStop(0.65, withAlpha(col, op));
    g.addColorStop(1, withAlpha(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. Click rings — expanding and fading at each press.
  if (fx.clicks) {
    const size = fx.clicks.size ?? CLICK_DEFAULTS.size;
    const dur = fx.clicks.duration ?? CLICK_DEFAULTS.duration;
    const col = fx.clicks.color ?? CLICK_DEFAULTS.color;
    for (const ct of clickTimes(samples)) {
      const age = localT - ct;
      if (age < 0 || age > dur) continue;
      const prog = age / dur;
      const c = cursorAt(samples, ct);
      if (!c) continue;
      const cx = box.left + (fx0 + (c.x / vw) * cfw) * box.vw;
      const cy = box.top + (fy0 + (c.y / vh) * cfh) * box.vh;
      const r = ((size * (0.25 + 0.75 * prog)) / 2) * unit;
      ctx.strokeStyle = withAlpha(col, 1 - prog);
      ctx.lineWidth = Math.max(1, size * 0.09 * unit);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 4. The pointer itself, on top — but only when Studio owns it. Over a
  //    recording with a burned-in cursor this would draw a second one, the
  //    same rule the renderer enforces.
  if (fx.pointer && track.hidden) {
    const size = (fx.pointer.size ?? PTR_DEFAULTS.size) * unit;
    const col = fx.pointer.color ?? PTR_DEFAULTS.color;
    const op = fx.pointer.opacity ?? PTR_DEFAULTS.opacity;
    ctx.globalAlpha = Math.max(0, Math.min(1, op));
    ctx.fillStyle = col;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = Math.max(1, size * 0.11);
    ctx.lineJoin = "round";

    const style = fx.pointer.style ?? PTR_DEFAULTS.style;
    if (style === "dot" || style === "ring") {
      ctx.beginPath();
      ctx.arc(px, py, size / 2, 0, Math.PI * 2);
      if (style === "ring") {
        ctx.lineWidth = Math.max(1, size * 0.22);
        ctx.strokeStyle = col;
        ctx.stroke();
      } else {
        ctx.fill();
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ARROW.forEach(([ax, ay], i) => {
        const x = px + ax * size;
        const y = py + ay * size;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    }
  }

  ctx.restore();
}

/** Hex (#rgb or #rrggbb) plus an alpha, as an rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) h = "ffcc33";
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}
