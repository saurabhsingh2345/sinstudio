// Lock a granted share onto a surface cursord can measure.
//
// This is the step that makes "record a window" and "record a tab" produce the
// same finished footage as "record a screen". The browser grants a share and
// says almost nothing about it; cursord can see every window's rectangle but
// not which one was granted; matchSurface joins the two on shape. This module
// runs that at the one moment it can be run — after the picker closes, while
// the track is still live and its settings are still readable.
//
// Everything here fails soft. No helper, no match, an old helper without
// surface support: the recording proceeds and the cursor effects are the thing
// that is missing, which is exactly what happened before any of this existed.

import { attachSurface, listSurfaces, type CursorSurface } from "./cursor";
import { displaySurfaceOf, trackFrameSize } from "./recorder";
import {
  insetFor,
  matchSurface,
  surfaceLabel,
  type CaptureShape,
  type SurfaceInset,
} from "./surfaceMatch";

export interface SurfaceLock {
  surface: CursorSurface;
  inset: SurfaceInset;
  /** Other surfaces that fitted, so the user can correct the pick. */
  candidates: CursorSurface[];
  ambiguous: boolean;
  /** The share this was matched against, kept so a correction can re-derive. */
  capture: CaptureShape;
}

/**
 * Work out what is being shared, and tell cursord to follow it.
 *
 * Returns null when nothing could be matched — an unrecognised share, a helper
 * that predates surfaces, or a platform without window geometry. The caller
 * treats that as "no pointer data for this take", which is honest: the
 * alternative is placing every effect through a rectangle that isn't the one
 * on screen, and being confidently wrong is worse than being absent.
 */
export async function lockSurface(stream: MediaStream): Promise<SurfaceLock | null> {
  const track = stream.getVideoTracks()[0];
  const frame = trackFrameSize(track);
  if (!frame) return null;

  const capture: CaptureShape = {
    surface: displaySurfaceOf(track),
    width: frame.width,
    height: frame.height,
    dpr: typeof window !== "undefined" ? window.devicePixelRatio : 1,
  };

  const surfaces = await listSurfaces();
  const match = matchSurface(surfaces, capture);
  if (!match) return null;
  // Attaching is what starts the bounds series. A match nobody was told about
  // is a match that does nothing.
  if (!(await attachSurface(match.surface.id))) return null;

  return { ...match, capture };
}

/** Re-point an existing lock at a different surface, after a user correction. */
export async function relockSurface(lock: SurfaceLock, surface: CursorSurface): Promise<SurfaceLock | null> {
  if (!(await attachSurface(surface.id))) return null;
  return {
    ...lock,
    surface,
    inset: insetFor(surface, lock.capture),
    // The user has said which one it is; that is better evidence than shape.
    ambiguous: false,
  };
}

/**
 * What to tell the user about a lock, or its absence.
 *
 * Said while the share is live and still cheap to redo, never after the take —
 * the way you used to learn a twenty-minute window recording would have no
 * camera work was by finishing it.
 */
export function lockNotice(
  lock: SurfaceLock | null,
  capture: { surface?: string },
  helperHasSurfaces: boolean
): { tone: "info" | "warn"; text: string } | null {
  const kind = capture.surface === "monitor" ? "screen" : capture.surface === "browser" ? "tab" : "window";
  if (!lock) {
    if (!helperHasSurfaces && kind !== "screen") {
      return {
        tone: "warn",
        text: `This cursor helper is too old to place pointer data in a ${kind} share, so there'll be no auto-zoom or click rings. Rebuild tools/cursord, or record a whole screen.`,
      };
    }
    return {
      tone: "warn",
      text: `Studio couldn't work out where this ${kind} is on screen, so there'll be no auto-zoom or click rings. Recording a whole screen always works.`,
    };
  }
  if (capture.surface === "browser") {
    return {
      tone: "info",
      text: `Tracking the pointer in ${surfaceLabel(lock.surface)}. A tab's position is estimated from its window — if the effects land high or low, record the window instead.`,
    };
  }
  if (lock.ambiguous) {
    return {
      tone: "info",
      text: `Tracking the pointer in ${surfaceLabel(lock.surface)} — more than one window is that shape, so check this is the right one.`,
    };
  }
  return { tone: "info", text: `Tracking the pointer in ${surfaceLabel(lock.surface)}.` };
}
