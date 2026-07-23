/*
Matching the project canvas to what was actually recorded.

A screen recording is the shape of the screen, and a screen is very often not
16:9 — a MacBook is 16:10 or 3:2, an external monitor might be 21:9. Dropped
into a 16:9 project, a 3:2 capture is letterboxed with black down both sides,
which is what "black screen at the side" is: not a zoom escaping the footage,
just a picture that was never the shape of the frame it was put in.

Stretching instead would be worse — the export scales the clip to the canvas, so
a mismatched capture comes out distorted rather than bordered, and a distorted
screen recording is harder to notice and harder to explain.

So the canvas adopts the recording. This is only ever done for the FIRST visual
clip in a project: after that the canvas is a decision someone has made, and
silently reshaping a timeline that already has content in it would move
everything already placed.
*/

/** The longest edge a derived canvas is allowed to have. */
const MAX_EDGE = 1920;

/** Codecs need even dimensions; an odd canvas is refused or silently rounded. */
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * The canvas that fits a recording without bars or distortion.
 *
 * Returns null when the source is unusable or already matches, so the caller
 * can leave a perfectly good canvas alone rather than rewriting it to itself.
 */
export function canvasForSource(
  src: { width: number; height: number },
  current: { width: number; height: number }
): { width: number; height: number } | null {
  if (!(src.width > 0) || !(src.height > 0)) return null;

  const scale = Math.min(1, MAX_EDGE / Math.max(src.width, src.height));
  const width = even(src.width * scale);
  const height = even(src.height * scale);

  // Already the right shape: a half-percent tolerance, because the recording's
  // own dimensions are rounded to even numbers by the capture pipeline and an
  // exact comparison would rewrite the canvas for a rounding difference.
  const a = width / height;
  const b = current.width / current.height;
  if (Math.abs(a - b) / b < 0.005) return null;

  return { width, height };
}
