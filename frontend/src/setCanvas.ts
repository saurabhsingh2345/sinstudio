/*
 * Changing the canvas — one implementation, three doors.
 *
 * Resizing the canvas is never only a resize: it decides what stays in frame.
 * TopBar's aspect menu learned that already ("setting the canvas alone drops a
 * 16:9 recording into a 1080x1920 letterbox with two thirds of the picture
 * missing"), and everything it learned has to hold for the Crop panel's
 * "Match canvas" and for a custom size typed into the menu. So the sequence
 * lives here rather than being copied twice more:
 *
 *   fetch the pointer sidecars → plan the reframe → write canvas AND patches
 *   inside ONE mutate, so the whole switch is a single undo.
 *
 * Half a reframe is worse than none.
 */

import { getCursorTrack, cursorTrackNow } from "./cursorTracks";
import { planReframe, reframeSummary } from "./reframe";
import type { EditDoc } from "./types";

export interface SetCanvasOptions {
  /**
   * A clip the new canvas is the exact shape of, whose `fit` should be cleared.
   *
   * Once the picture and the frame are the same shape, "fill" and "fit" produce
   * identical pixels — but the panel would still read "Fill", which says the
   * edges are being cropped when nothing is. Matching to a clip should leave
   * that clip saying what is actually happening to it.
   */
  matchedClipId?: string;
}

/**
 * Apply a canvas size to the document, reframing the content to suit.
 *
 * Returns the one-line summary for a toast, or null when nothing but the frame
 * changed.
 */
export async function applyCanvas(
  doc: EditDoc,
  canvas: { width: number; height: number; fps?: number },
  mutate: (fn: (d: EditDoc) => void) => void,
  opts: SetCanvasOptions = {}
): Promise<string | null> {
  // Fetched first because the reframe recomputes each recording's camera for the
  // new shape and that needs the track. A clip whose sidecar cannot be fetched
  // is still filled to the frame — a worse result rather than a wrong one.
  await Promise.all(
    (doc.assets ?? [])
      .filter((a) => a.hasCursor)
      .map((a) => getCursorTrack(doc.id, a.id).catch(() => null))
  );

  const plan = planReframe(doc, canvas, (assetId) => cursorTrackNow(doc.id, assetId));

  mutate((d) => {
    d.canvas.width = canvas.width;
    d.canvas.height = canvas.height;
    if (canvas.fps && canvas.fps > 0) d.canvas.fps = canvas.fps;
    for (const u of plan.patches) {
      const c = d.tracks.find((t) => t.id === u.trackId)?.clips?.find((x) => x.id === u.clipId);
      if (c) Object.assign(c, u.patch);
    }
    if (opts.matchedClipId) {
      for (const t of d.tracks) {
        const c = t.clips?.find((x) => x.id === opts.matchedClipId);
        if (c) {
          delete c.fit;
          // The fill focus went with the fit: there is no overflow left to aim.
          delete c.fillFocusX;
          delete c.fillFocusY;
        }
      }
    }
  });

  return reframeSummary(plan);
}
