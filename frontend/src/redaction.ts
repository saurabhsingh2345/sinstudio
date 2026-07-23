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
