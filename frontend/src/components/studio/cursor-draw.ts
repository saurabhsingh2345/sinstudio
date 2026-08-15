import type { CursorSample, CursorSidecar } from "../../cursor";
import type { Asset, Clip } from "../../types";
import { clipSourceAt } from "../../types";
import { coverBox, contentBox } from "../../zoomPan";
import { backdropLayout } from "../../backdrop";
import { fillsFrame } from "../../crop";
import { ease } from "../../ease";

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

/*
 * Auto-hide: fading out a pointer that has been parked.
 *
 * Mirrors backend/internal/render/cursoridle.go — the constants, the stillness
 * tolerance and the asymmetric fades are all its numbers, and cursor-draw.test.ts
 * asserts the same goldens TestPointerAlphaGolden does. Unlike the shapes, this
 * one is not allowed to be approximate: a preview that shows a cursor the export
 * hides is not a preview of the export.
 */
export const FADE_OUT = 0.45;
export const FADE_IN = 0.12;
const IDLE_PX = 3;
const IDLE_REF = 1920;

export interface IdleSpan {
  start: number;
  end: number;
}

/** Mirrors render.pointerIdleSpans. Times are source seconds. */
export function idleSpans(
  samples: CursorSample[],
  videoW: number,
  hideAfter: number
): IdleSpan[] {
  if (samples.length < 2 || hideAfter <= 0) return [];
  const tol = videoW > 0 ? (IDLE_PX * videoW) / IDLE_REF : IDLE_PX;

  const out: IdleSpan[] = [];
  let anchor = samples[0];
  let start = samples[0].t / 1000;
  let down = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const t = s.t / 1000;
    const moved = Math.hypot(s.x - anchor.x, s.y - anchor.y) > tol;
    // A press or a release is activity even at a standstill — a click that
    // lands without nudging the mouse is the pointer being used.
    const d = s.down ?? 0;
    const clicked = d !== down;
    down = d;
    if (!moved && !clicked) continue;
    if (t - start > hideAfter) out.push({ start, end: t });
    anchor = s;
    start = t;
  }
  const last = samples[samples.length - 1].t / 1000;
  if (last - start > hideAfter) out.push({ start, end: last });
  return out;
}

/** Mirrors render.pointerAlphaAt: the pointer's opacity multiplier at time t. */
export function pointerAlphaAt(spans: IdleSpan[], hideAfter: number, t: number): number {
  let a = 1;
  for (const s of spans) {
    if (t < s.start) break;
    const hideAt = s.start + hideAfter;
    if (t <= s.end) {
      a = 1 - clamp01((t - hideAt) / FADE_OUT);
      break;
    }
    // Coming back from wherever the fade-out actually got to, not from zero:
    // a park that ends mid-fade would otherwise flash the cursor away first.
    const reached = 1 - clamp01((s.end - hideAt) / FADE_OUT);
    a = reached + (1 - reached) * clamp01((t - s.end) / FADE_IN);
  }
  return clamp01(a);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/*
 * The cursor's own reaction to a click.
 *
 * Mirrors render.pointerClickScale, curve for curve — it is built on the same
 * shared easings (ease.ts / easeValue), so the press dips and springs back
 * identically in both halves. cursor-draw.test.ts asserts the Go goldens.
 */
const DIP_IN = 0.06;
const DIP_OUT = 0.26;
const DIP_MAX = 0.28;

/*
 * Gliding the cursor home, so a looping demo has no jump cut.
 *
 * Mirrors render.loopReturnPath. The rule that matters is the one about clicks:
 * the glide is a fiction, and a fiction that drags the pointer off the button it
 * is pressing is worse than the jump it fixes, so a click inside the window
 * pushes the glide's start past it rather than distorting it.
 */
const LOOP_CLICK_HOLD = 0.3;

/** Mirrors render.loopReturnPath. from/to are the clip's visible source range. */
export function loopReturnPath(
  samples: CursorSample[],
  dur: number,
  from: number,
  to: number
): CursorSample[] {
  if (dur <= 0 || samples.length < 2 || to <= from) return samples;
  const home = cursorAt(samples, from);
  if (!home) return samples;

  let begin = Math.max(from, to - dur);
  let prev = 0;
  for (const s of samples) {
    const t = s.t / 1000;
    if (t > to) break;
    const d = s.down ?? 0;
    if (d !== 0 && prev === 0 && t + LOOP_CLICK_HOLD > begin) begin = t + LOOP_CLICK_HOLD;
    prev = d;
  }
  if (begin >= to) return samples;

  const span = to - begin;
  return samples.map((s) => {
    const t = s.t / 1000;
    if (t <= begin || t > to) return s;
    // Smootherstep, so the glide leaves and arrives at rest. A linear walk home
    // reads as the cursor being dragged by something.
    const p = ease("easeInOut", (t - begin) / span);
    return {
      ...s,
      x: Math.trunc(s.x * (1 - p) + home.x * p),
      y: Math.trunc(s.y * (1 - p) + home.y * p),
    };
  });
}

/*
 * Motion blur on the cursor itself.
 *
 * Mirrors render.pointerBlurSigma exactly — the sigmas are the shared,
 * golden-tested number. How they are *drawn* is not shared: the exporter runs a
 * real gaussian per axis, and canvas has only an isotropic filter, so the
 * preview lays down a few ghost copies along the travel instead. That is a
 * genuine approximation of the texture, in the same spirit as the mosaic the
 * redaction preview cannot do. The extent and the timing are exact.
 */
const BLUR_TRAVEL_K = 0.33;
const BLUR_MIN_TRAVEL = 1.5;
const BLUR_MAX_OF_SIZE = 0.2;

/** Mirrors render.pointerBlurSigma. Velocity and size in the same unit. */
export function pointerBlurSigma(
  vx: number,
  vy: number,
  amount: number,
  size: number,
  fps: number
): [number, number] {
  if (amount <= 0 || fps <= 0 || size <= 0) return [0, 0];
  const a = clamp01(amount);
  const max = size * BLUR_MAX_OF_SIZE * a;
  const axis = (v: number) => {
    const travel = Math.abs(v) / fps;
    if (travel < BLUR_MIN_TRAVEL) return 0;
    return Math.max(0, Math.min(max, (travel - BLUR_MIN_TRAVEL) * BLUR_TRAVEL_K * a));
  };
  return [axis(vx), axis(vy)];
}

/** The drawn cursor's size multiplier at source time t. */
export function pointerClickScale(clicks: number[], t: number, amount: number): number {
  if (amount <= 0 || !clicks.length) return 1;
  const depth = clamp01(amount) * DIP_MAX;
  for (const ct of clicks) {
    const d = t - ct;
    if (d < 0 || d > DIP_IN + DIP_OUT) continue;
    if (d <= DIP_IN) return 1 - depth * ease("easeOutCubic", d / DIP_IN);
    // easeOutBack overshoots, so the cursor passes a shade beyond its own size
    // before settling. That is what makes the press read as sprung rather than
    // merely animated, and unlike the camera's overshoot it costs nothing.
    return 1 - depth * (1 - ease("easeOutBack", (d - DIP_IN) / DIP_OUT));
  }
  return 1;
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

/*
 * The system cursors, as single polygons — the same numbers as
 * render.cursorShapes, pinned by the same checksum (TestCursorShapesGolden /
 * "cursor shapes" below).
 *
 * hotX/hotY is the point that sits on the recorded coordinate. Every shape is
 * drawn from its hotspot, so the preview needs no offset arithmetic and a
 * resized cursor stays on what it is pointing at for free.
 */
export const KIND_ARROW = 1;
export const KIND_TEXT = 2;
export const KIND_HAND = 3;
export const KIND_CROSS = 4;
export const KIND_RESIZE_H = 5;
export const KIND_RESIZE_V = 6;

export interface CursorShape {
  path: [number, number][];
  hotX: number;
  hotY: number;
  w: number;
  h: number;
}

export const CURSOR_SHAPES: Record<number, CursorShape> = {
  [KIND_ARROW]: { path: ARROW, hotX: 0, hotY: 0, w: 0.8, h: 1.12 },
  [KIND_TEXT]: {
    path: [
      [0.0, 0.0], [0.5, 0.0], [0.5, 0.12], [0.34, 0.12],
      [0.34, 0.88], [0.5, 0.88], [0.5, 1.0], [0.0, 1.0],
      [0.0, 0.88], [0.16, 0.88], [0.16, 0.12], [0.0, 0.12],
    ],
    hotX: 0.25, hotY: 0.5, w: 0.5, h: 1.0,
  },
  [KIND_HAND]: {
    path: [
      [0.16, 0.0], [0.3, 0.0], [0.3, 0.42], [0.38, 0.34],
      [0.46, 0.34], [0.46, 0.46], [0.52, 0.4], [0.6, 0.4],
      [0.6, 0.5], [0.66, 0.46], [0.74, 0.46], [0.74, 1.0],
      [0.2, 1.0], [0.06, 0.72], [0.06, 0.56], [0.16, 0.52],
    ],
    hotX: 0.23, hotY: 0.0, w: 0.74, h: 1.0,
  },
  [KIND_CROSS]: {
    path: [
      [0.44, 0.0], [0.56, 0.0], [0.56, 0.44], [1.0, 0.44],
      [1.0, 0.56], [0.56, 0.56], [0.56, 1.0], [0.44, 1.0],
      [0.44, 0.56], [0.0, 0.56], [0.0, 0.44], [0.44, 0.44],
    ],
    hotX: 0.5, hotY: 0.5, w: 1.0, h: 1.0,
  },
  [KIND_RESIZE_H]: {
    path: [
      [0.0, 0.3], [0.22, 0.06], [0.22, 0.22], [0.78, 0.22],
      [0.78, 0.06], [1.0, 0.3], [0.78, 0.54], [0.78, 0.38],
      [0.22, 0.38], [0.22, 0.54],
    ],
    hotX: 0.5, hotY: 0.3, w: 1.0, h: 0.6,
  },
  [KIND_RESIZE_V]: {
    path: [
      [0.3, 0.0], [0.06, 0.22], [0.22, 0.22], [0.22, 0.78],
      [0.06, 0.78], [0.3, 1.0], [0.54, 0.78], [0.38, 0.78],
      [0.38, 0.22], [0.54, 0.22],
    ],
    hotX: 0.3, hotY: 0.5, w: 0.6, h: 1.0,
  },
};

/** Mirrors render.shapeFor: anything unnameable is drawn as an arrow. */
export const shapeFor = (kind: number | undefined): CursorShape =>
  CURSOR_SHAPES[kind ?? 0] ?? CURSOR_SHAPES[KIND_ARROW];

/**
 * Which shape was showing at a source time.
 *
 * Deliberately reads the raw nearest-preceding sample rather than reproducing
 * the exporter's span smoothing. The smoothing exists to stop the EXPORT
 * rebuilding its overlay set around a flicker; scrubbing a preview past a
 * one-frame shape change costs nothing, and matching the exporter here would
 * mean carrying its whole span machinery into the draw loop.
 */
export function kindAt(samples: CursorSample[], tSec: number): number {
  const ms = tSec * 1000;
  let k = KIND_ARROW;
  for (const s of samples) {
    if (s.t > ms) break;
    k = s.k || KIND_ARROW;
  }
  return k;
}

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
  canvasScale: number,
  _asset?: Pick<Asset, "hasCursor">,
  /** Whether the CAMERA is working this clip — cursor effects or zoom
   *  keyframes. Only decides whether the backdrop draws its card, which is the
   *  one thing that genuinely turns on it; where the picture sits is decided by
   *  the clip's fit. */
  camera = false,
  /** When set, use the video element's clock so overlays match what's on screen. */
  mediaT?: number,
  /** The project's frame rate. Motion blur models one frame's exposure, so the
   *  same flick smears half as far at 60fps as at 30 — see pointerBlurSigma. */
  fps = 30
) {
  const fx = clip.cursor;
  if (!fx || !track.samples.length) return;

  // Click timestamps and cursor samples are in SOURCE seconds (from the first
  // video frame). localT is clip-local play time — they only match when in=0.
  const srcT = mediaT ?? clipSourceAt(clip, localT);

  const smoothing = fx.pointer?.smoothing ?? 0;
  // No camera term: render.buildCursorFX smooths whenever smoothing is asked
  // for and the track is hidden, so excluding camera clips here meant the
  // preview never smoothed a screen recording — every one of them is a camera
  // clip — while the export always did.
  const useSmooth = fx.pointer && smoothing > 0 && track.hidden;
  const smoothed = useSmooth ? smoothSamples(track.samples, smoothing) : track.samples;
  // The loop return goes after smoothing and before everything else, so the
  // glide home is the path every effect agrees the pointer took — including the
  // auto-hide, which then treats it as the movement it is.
  const loop = fx.pointer?.loopReturn ?? 0;
  const samples =
    loop > 0 && track.hidden ? loopReturnPath(smoothed, loop, clip.in, clip.out) : smoothed;

  const at = cursorAt(samples, srcT);
  if (!at) return;

  // Auto-hide dims the pointer and the disc that follows it, together. Fading
  // one without the other would leave an amber blob hovering over nothing.
  // The spotlight is deliberately exempt: it is a dimming mask, so fading it
  // would brighten the frame rather than remove anything.
  const hideAfter = fx.pointer?.autoHide ?? 0;
  const idleAlpha =
    hideAfter > 0 && track.hidden
      ? pointerAlphaAt(idleSpans(samples, track.video.width, hideAfter), hideAfter, srcT)
      : 1;

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
  const W = stageW / Math.max(1e-6, canvasScale);
  const H = stageH / Math.max(1e-6, canvasScale);
  // Order and conditions mirror cursorfx.go's contentFracFor exactly: the card
  // is only drawn when the camera is not working the clip, and where the
  // picture sits otherwise follows from how it was fitted — not from whether
  // the clip happens to be zoomed at this instant, which is what this asked
  // before and which moved every effect sideways mid-push-in.
  if (clip.backdrop && !clip.device && !camera) {
    const g = backdropLayout(clip.backdrop, vw, vh, Math.round(W), Math.round(H));
    fx0 = g.x / W;
    fy0 = g.y / H;
    cfw = g.w / W;
    cfh = g.h / H;
  } else if (fillsFrame(clip.fit)) {
    const cb = coverBox({ width: vw, height: vh }, { width: W, height: H });
    fx0 = cb.x0 / W;
    fy0 = cb.y0 / H;
    cfw = (cb.x1 - cb.x0) / W;
    cfh = (cb.y1 - cb.y0) / H;
  } else {
    const canA = W / H;
    if (Math.abs(vw / vh - canA) / canA > 0.005) {
      const cb = contentBox({ width: vw, height: vh }, { width: W, height: H });
      fx0 = cb.x0 / W;
      fy0 = cb.y0 / H;
      cfw = (cb.x1 - cb.x0) / W;
      cfh = (cb.y1 - cb.y0) / H;
    }
  }
  // Pointer position on the stage, via the clip's box.
  const toStage = (p: { x: number; y: number }): [number, number] => [
    box.left + (fx0 + (p.x / vw) * cfw) * box.vw,
    box.top + (fy0 + (p.y / vh) * cfh) * box.vh,
  ];
  const [px, py] = toStage(at);
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
  if (fx.highlight && idleAlpha > 0) {
    const r = ((fx.highlight.size ?? HL_DEFAULTS.size) / 2) * unit;
    const op = (fx.highlight.opacity ?? HL_DEFAULTS.opacity) * idleAlpha;
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
      const age = srcT - ct;
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
  if (fx.pointer && track.hidden && idleAlpha > 0) {
    // The dip scales the drawn shape about its own hotspot for free here: the
    // arrow is drawn outward from its tip and the round styles are drawn about
    // their centre, so neither moves as the size changes. The exporter has to
    // scale the hotspot offset by hand to get the same result.
    const dip = fx.pointer.clickDip
      ? pointerClickScale(clickTimes(samples), srcT, fx.pointer.clickDip)
      : 1;
    const size = (fx.pointer.size ?? PTR_DEFAULTS.size) * unit * dip;
    const col = fx.pointer.color ?? PTR_DEFAULTS.color;
    const op = (fx.pointer.opacity ?? PTR_DEFAULTS.opacity) * idleAlpha;
    const style = fx.pointer.style ?? PTR_DEFAULTS.style;

    // Which system cursor was showing. A stylised pointer opts out — asking
    // for a dot and getting an I-beam over every text field would be ignoring
    // what was asked for, and the exporter makes the same exception.
    const drawn = shapeFor(style === "dot" || style === "ring" ? KIND_ARROW : kindAt(samples, srcT));

    const shape = (ox: number, oy: number) => {
      ctx.fillStyle = col;
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = Math.max(1, size * 0.11);
      ctx.lineJoin = "round";
      if (style === "dot" || style === "ring") {
        ctx.beginPath();
        ctx.arc(px + ox, py + oy, size / 2, 0, Math.PI * 2);
        if (style === "ring") {
          ctx.lineWidth = Math.max(1, size * 0.22);
          ctx.strokeStyle = col;
          ctx.stroke();
        } else {
          ctx.fill();
          ctx.stroke();
        }
      } else {
        // `size` is the shape's HEIGHT, as in the exporter, so a crosshair and
        // an I-beam read as the same weight at the same setting. Drawn from
        // the hotspot, which keeps every shape on its own coordinate.
        const k = size / drawn.h;
        ctx.beginPath();
        drawn.path.forEach(([ax, ay], i) => {
          const x = px + ox + (ax - drawn.hotX) * k;
          const y = py + oy + (ay - drawn.hotY) * k;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
      }
    };

    // Motion blur. The travel is measured over exactly one frame — the same
    // exposure the exporter models — by asking where the pointer was a frame
    // ago, which needs no state carried between draws.
    const amount = fx.pointer.motionBlur ?? 0;
    let sx = 0;
    let sy = 0;
    if (amount > 0 && fps > 0) {
      const prev = cursorAt(samples, srcT - 1 / fps);
      if (prev) {
        const [qx, qy] = toStage(prev);
        [sx, sy] = pointerBlurSigma((px - qx) * fps, (py - qy) * fps, amount, size, fps);
      }
    }

    if (sx > 0.5 || sy > 0.5) {
      // A box smear along the travel, in place of the gaussian the export runs.
      // Ghost copies rather than ctx.filter because canvas blur is isotropic —
      // it would round a horizontal flick out in every direction, which is the
      // opposite of what motion blur says about the movement.
      const n = 5;
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1) - 0.5;
        ctx.globalAlpha = clamp01(op) / n;
        shape(sx * 3 * f, sy * 3 * f);
      }
    } else {
      ctx.globalAlpha = clamp01(op);
      shape(0, 0);
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
