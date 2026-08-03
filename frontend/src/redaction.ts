import type { Rect } from "./crop";
import type { Redaction, RedactKind } from "./types";

// Region blur / pixelate — hiding a password, a name, a licence key.
//
// Twin of backend/internal/render/redaction.go. The renderer resamples the
// region: it scales the crop down by a factor and back up, so the strength is
// relative to the region's own size and a 4K capture is as hidden as a 720p one.
// The preview cannot resample a live <video>, so it approximates with a CSS
// backdrop filter — see previewBlurPx for how the two are tied together.

export const REDACT_KINDS: { kind: RedactKind; label: string }[] = [
  { kind: "blur", label: "Blur" },
  { kind: "pixelate", label: "Pixelate" },
];

/**
 * The renderer's resampling factor. Mirrors redactionStrength() in Go, including
 * treating 0 as unset — the schema cannot distinguish an omitted field from a
 * zero one, and a factor of 0 would mean no protection at all.
 */
export function redactionStrength(amount: number | undefined): number {
  const a = !amount || amount <= 0 ? 0.6 : Math.max(0, Math.min(1, amount));
  return 4 + a * 28; // 4×..32×
}

/**
 * CSS blur radius that reads like the renderer's resampling, in screen px.
 *
 * Downsampling by N and back destroys detail comparably to a blur of about N/2
 * source pixels, so the radius is that, carried into screen space by however
 * much the clip is currently displayed at. Without the source→screen conversion
 * the preview would look wildly over- or under-blurred on anything whose native
 * size isn't the size it's shown at, which for a screen recording is always.
 */
export function previewBlurPx(amount: number | undefined, displayedW: number, sourceW: number): number {
  const n = redactionStrength(amount);
  const scale = sourceW > 0 ? displayedW / sourceW : 1;
  return Math.max(1, (n / 2) * scale);
}

/** A new region, placed in the middle at a grabbable size. */
export function newRedaction(kind: RedactKind = "blur"): Redaction {
  return { kind, x: 0.35, y: 0.4, w: 0.3, h: 0.15, amount: 0.6 };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Keep a region inside the frame and big enough to mean something.
 *
 * The renderer drops a degenerate region rather than emitting a zero-sized crop
 * (which fails the whole export), so one dragged to nothing here would silently
 * stop protecting anything. Clamping in the editor keeps what you see and what
 * ships the same.
 */
export function clampRedaction(r: Redaction): Redaction {
  const w = Math.max(0.01, Math.min(1, r.w));
  const h = Math.max(0.01, Math.min(1, r.h));
  return { ...r, x: clamp01(Math.min(r.x, 1 - w)), y: clamp01(Math.min(r.y, 1 - h)), w, h };
}

/** Normalize a rectangle dragged in any direction to a positive one. */
export function normRedaction(r: Redaction): Redaction {
  return clampRedaction({
    ...r,
    x: r.w < 0 ? r.x + r.w : r.x,
    y: r.h < 0 ? r.y + r.h : r.y,
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  });
}

/*
 * Time windows. Twin of Redaction.Window/Timed in schema.go — the preview has to
 * agree with the renderer about when a region is live, or a blur that is on in
 * the editor is off in the file.
 */

/** Is this region bounded to less than the whole clip? */
export function isTimed(r: Redaction, playDur: number): boolean {
  return (r.start ?? 0) > 0 || ((r.end ?? 0) > 0 && (r.end as number) < playDur);
}

/** The region's window in clip-local seconds, with both ends opened out. */
export function redactionWindow(r: Redaction, playDur: number): { from: number; to: number } {
  const from = (r.start ?? 0) > 0 ? (r.start as number) : 0;
  const end = r.end ?? 0;
  const to = end > 0 && end < playDur ? end : playDur;
  return { from, to: Math.max(from, to) };
}

/** Is the region showing at this clip-local time? */
export function isLiveAt(r: Redaction, localT: number, playDur: number): boolean {
  const { from, to } = redactionWindow(r, playDur);
  return localT >= from && localT <= to;
}

/**
 * The regions that survive one half of a split, retimed onto it.
 *
 * `from`/`to` are the half's span in the ORIGINAL clip's local seconds, and
 * playDur is that clip's length, needed to resolve an unset `end` into a real
 * one before it can be clipped. Windows are intersected with the half and
 * rebased onto it; a region the half never shows is dropped rather than carried
 * with an empty window.
 *
 * Getting this wrong is not cosmetic. A blur whose window is not rebased slides
 * onto a different moment of the second half — which for a redaction means
 * uncovering the thing it was put there to hide.
 */
export function splitRedactions(
  regions: Redaction[] | undefined,
  from: number,
  to: number,
  playDur: number
): Redaction[] | undefined {
  if (!regions?.length) return undefined;
  const half = to - from;
  const out: Redaction[] = [];
  for (const r of regions) {
    const w = redactionWindow(r, playDur);
    const lo = Math.max(w.from, from);
    const hi = Math.min(w.to, to);
    if (hi - lo <= 1e-4) continue; // this half never shows it
    const start = lo - from;
    const end = hi - from;
    out.push({
      ...r,
      // Back to "unset" whenever the clipped window reaches a boundary, so a
      // whole-clip region stays whole-clip on both halves rather than acquiring
      // explicit bounds that mean the same thing.
      start: start > 1e-4 ? +start.toFixed(4) : undefined,
      end: end < half - 1e-4 ? +end.toFixed(4) : undefined,
    });
  }
  return out.length ? out : undefined;
}

/*
 * Source fractions ⇄ stage pixels.
 *
 * A redaction's numbers are fractions of the clip's UNCROPPED source, because
 * the renderer applies them before the crop — that is what stops trimming an
 * edge from sliding a blur off the thing it was hiding.
 *
 * So the rectangle they describe is a rectangle of `cropLayout().media`, which
 * is the whole source laid out in the clip's box, and NOT of the box itself.
 * Measuring against the box is right only while there is no crop, and silently
 * wrong the moment there is one: the preview shows the blur somewhere the export
 * will not put it.
 */

/**
 * Where a region lands, in px relative to the CROP WINDOW — the same space
 * cropLayout's `media` is expressed in, because that is the element the region
 * is glued to. Not the clip's box: under `fill` the window starts outside the
 * box, and treating the two as the same shifts every region by that offset.
 */
export function redactionRect(r: Redaction, media: Rect): Rect {
  return {
    left: media.left + r.x * media.width,
    top: media.top + r.y * media.height,
    width: r.w * media.width,
    height: r.h * media.height,
  };
}

/** The inverse: a point in the clip's box, as a fraction of the source. */
export function sourceFraction(bx: number, by: number, media: Rect): { x: number; y: number } {
  return {
    x: media.width > 0 ? (bx - media.left) / media.width : 0,
    y: media.height > 0 ? (by - media.top) / media.height : 0,
  };
}

/** The region described by dragging from one point to another, in box px. */
export function redactionFromDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  media: Rect,
  kind: RedactKind = "blur"
): Redaction {
  const a = sourceFraction(from.x, from.y, media);
  const b = sourceFraction(to.x, to.y, media);
  return normRedaction({ kind, x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, amount: 0.6 });
}
