import type { CursorSidecar } from "./cursor";
import { SMART_FOCUS_DEFAULTS, smartFocus, type SmartFocusOptions } from "./smartFocus";
import { VIRTUAL_CAMERA_OPTS } from "./virtualCamera";
import type { Asset, Clip } from "./types";

/*
What happens to a screen recording the moment it lands on the timeline.

This is the difference between a screen recorder and a video editor that can
zoom. The analysis was always correct and always available — it simply never ran
unless the user found a collapsed panel six scrolls down the inspector, so a
recording arrived flat and looked like the pointer had never been tracked.

It lives here, apart from the record panel, so it can be TESTED. Wiring buried
in a component's async callback is wiring nobody can exercise without a real
screen share and a user gesture, and that is exactly the code that had been
shipping unverified.
*/

export interface AutoFrame {
  /** The clip patch to apply. One patch, so the whole pass is a single undo. */
  patch: Partial<Clip>;
  /** How many zooms were found, for the toast. Zero is normal and fine. */
  zooms: number;
}

/**
 * Decide how to frame a freshly-recorded clip.
 *
 * Returns null when there is nothing to do, which the caller treats as "leave
 * the clip alone" rather than as a failure — most imports are not screen
 * recordings and must pass through untouched.
 */
export function autoFrame(
  asset: Pick<Asset, "hasCursor" | "cursorHidden">,
  clip: Pick<Clip, "keyframes">,
  track: Pick<CursorSidecar, "samples" | "video"> | null | undefined,
  duration: number,
  canvas: { width: number; height: number },
  opts: SmartFocusOptions = { ...SMART_FOCUS_DEFAULTS, ...VIRTUAL_CAMERA_OPTS },
  showClicks = true
): AutoFrame | null {
  // Only a recording that actually carries a pointer track. On anything else
  // there is nothing to be attentive to, and inventing motion for an imported
  // clip would be worse than leaving it alone.
  if (!asset.hasCursor || !track || !track.samples?.length) return null;
  if (duration <= 0) return null;

  const { keyframes, segments } = smartFocus(track as never, duration, canvas, opts);

  const patch: Clip = {} as Clip;
  const out: Partial<Clip> = patch;

  // Cursor emphasis when zoom was found or clicks are wanted.
  const cursor: NonNullable<Clip["cursor"]> = {};
  if (showClicks) cursor.clicks = {};
  if (asset.cursorHidden) cursor.pointer = { smoothing: 0.5 };
  if (cursor.clicks || cursor.pointer) out.cursor = cursor;

  if (segments.length) {
    // Merge rather than replace, so anything already keyed on this clip — an
    // opacity fade, a rotation — survives being framed.
    out.keyframes = { ...(clip.keyframes ?? {}), ...keyframes };
  }

  return { patch: out, zooms: segments.length };
}
