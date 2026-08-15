// Talks to cursord, the optional local helper that records pointer position
// and clicks during a screen capture (tools/cursord).
//
// The browser is the right side of this conversation even though the backend
// is where sidecars end up: cursord has to run on the machine being recorded,
// and the backend may not be that machine. The tab is.
//
// Everything here degrades. If the helper is not running you still get the
// recording, just without the data cursor effects need.

import type { SurfaceInset } from "./surfaceMatch";

export const CURSORD_ORIGIN = "http://127.0.0.1:8791";

export interface CursorHealth {
  ok: boolean;
  platform: string;
  supported: boolean;
  clicks: boolean;
  /**
   * Whether this helper can report window and display geometry. Absent on
   * helpers built before that existed, which is why every use of it is a
   * truthiness test: an old binary means whole-screen recordings only, exactly
   * as before.
   */
  surfaces?: boolean;
  /**
   * Whether this helper can report which system cursor is showing. Same
   * contract as surfaces: absent on older binaries, so every use is a
   * truthiness test and the fallback is the arrow throughout.
   */
  kinds?: boolean;
  screen: { width: number; height: number };
}

export interface CursorSample {
  t: number; // epoch ms
  x: number;
  y: number;
  down?: number; // 1 = left, 2 = right (bitmask)
  /** Which system cursor was showing — see CURSOR_SHAPES in cursor-draw.ts.
   *  Absent means the recorder could not tell, and everything draws the arrow. */
  k?: number;
}

/** A display or a window cursord can see, with its rectangle on the screen. */
export interface CursorSurface {
  id: string; // "display:1" | "window:11800"
  kind: "display" | "window";
  app?: string;
  title?: string;
  rect: { x: number; y: number; w: number; h: number };
  front: number; // 0 = frontmost
}

/** Where the captured surface was at a moment. */
export interface CursorBounds {
  t: number; // epoch ms
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CursorRecording {
  version: number;
  startedAt: number;
  stoppedAt: number;
  screen: { width: number; height: number };
  samples: CursorSample[];
  clicks: boolean;
  /** Cursor shapes could be read. Absent on helpers built before that existed. */
  kinds?: boolean;
  /** Set when Studio told the helper what was being captured. */
  surface?: CursorSurface;
  /** That surface's rectangle over time. Empty when none was attached. */
  bounds?: CursorBounds[];
}

// The sidecar Studio stores next to a recording. Times are milliseconds from
// the first video frame, and coordinates are in the recorded video's own pixel
// space — so a consumer needs to know nothing about the display it came from.
export interface CursorSidecar {
  version: number;
  video: { width: number; height: number };
  clicks: boolean;
  /** The OS cursor was kept out of the capture, so the renderer draws it. */
  hidden?: boolean;
  /** Cursor SHAPES could be read. False or absent means every sample's k is 0
   *  because nothing was looking, not because the pointer was an arrow. */
  kinds?: boolean;
  samples: CursorSample[];
}

const timeout = (ms: number) => {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
};

/** Is the helper running? Fails fast and quietly — absence is the normal case. */
export async function probeCursord(): Promise<CursorHealth | null> {
  try {
    const r = await fetch(`${CURSORD_ORIGIN}/health`, { signal: timeout(700) });
    if (!r.ok) return null;
    const h = (await r.json()) as CursorHealth;
    return h.ok ? h : null;
  } catch {
    return null;
  }
}

export async function startCursorTracking(): Promise<boolean> {
  try {
    const r = await fetch(`${CURSORD_ORIGIN}/start`, { method: "POST", signal: timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function stopCursorTracking(): Promise<CursorRecording | null> {
  try {
    const r = await fetch(`${CURSORD_ORIGIN}/stop`, { method: "POST", signal: timeout(5000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { ok: boolean; recording: CursorRecording };
    return body.ok ? body.recording : null;
  } catch {
    return null;
  }
}

/** Everything the helper can see being captured right now. */
export async function listSurfaces(): Promise<CursorSurface[]> {
  try {
    const r = await fetch(`${CURSORD_ORIGIN}/surfaces`, { signal: timeout(2000) });
    if (!r.ok) return [];
    const body = (await r.json()) as { ok: boolean; surfaces: CursorSurface[] };
    return body.ok ? body.surfaces ?? [] : [];
  } catch {
    return [];
  }
}

/**
 * Tell the helper which surface the live session is capturing.
 *
 * From here it samples that rectangle alongside the pointer, so a window that
 * is dragged mid-take keeps its effects.
 */
export async function attachSurface(id: string): Promise<CursorSurface | null> {
  try {
    const r = await fetch(`${CURSORD_ORIGIN}/surface`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal: timeout(2000) as AbortSignal,
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { ok: boolean; surface: CursorSurface };
    return body.ok ? body.surface : null;
  } catch {
    return null;
  }
}

/**
 * Whether pointer coordinates can be placed in this recording's frame.
 *
 * The question used to be about the KIND of share: cursord reported the pointer
 * in whole-screen coordinates, so only a whole-screen video was in the same
 * space, and window or tab shares were refused. That refusal is why a window
 * recording arrived with no auto-zoom, no click rings and no cursor at all.
 *
 * Now the question is about EVIDENCE. A session that was told what it was
 * capturing carries that surface's rectangle over time, and every share maps
 * the same way through it — a whole display being the case where the rectangle
 * happens to be the display. A session with no surface falls back to the old
 * rule, because whole-screen coordinates against a whole-screen video is the
 * one case that needs no rectangle to be correct.
 */
export function canMapToVideo(surface: string | undefined, rec?: CursorRecording | null): boolean {
  if (rec && hasSurfaceBounds(rec)) return true;
  return surface === "monitor";
}

/** Did this session actually record a rectangle to map through? */
export function hasSurfaceBounds(rec: CursorRecording | null | undefined): boolean {
  return !!rec?.bounds?.length && !!rec.surface;
}

/**
 * The crop a region recording applied, in captured-frame pixels.
 *
 * Needed because the two coordinate systems stop agreeing once a region is
 * recorded: cursord still reports against the whole screen, while the video is
 * now a rectangle inside it. Scaling needs the full frame; placing needs the
 * region's origin. Both, or the pointer lands somewhere it never was.
 */
export interface CaptureCrop {
  /** The whole captured frame the region was taken from. */
  frame: { width: number; height: number };
  /** The region's top-left within that frame. */
  x: number;
  y: number;
}

/**
 * Convert a cursord session into a sidecar aligned to one recorded track.
 *
 * `videoStartedAt` is when that MediaRecorder actually began — cursord starts
 * earlier (we ask it first so no motion is missed), so samples before frame
 * zero are dropped rather than given negative timestamps.
 *
 * Scaling handles the display-vs-capture resolution gap: a Retina screen
 * reported at 1728 wide may be captured at 1728 or 3456, and a constrained
 * capture may be smaller than either.
 *
 * `crop` additionally shifts samples into a region recording's own frame. This
 * is the single boundary where pointer coordinates are converted, which is why
 * the offset belongs here: everything downstream — renderer, preview, the
 * sidecar's own contract that coordinates are in the recorded video's pixel
 * space — then needs to know nothing about regions at all.
 */
export function toSidecar(
  rec: CursorRecording,
  videoStartedAt: number,
  video: { width: number; height: number },
  cursorHidden = false,
  crop?: CaptureCrop,
  inset?: SurfaceInset
): CursorSidecar {
  // Scale against the WHOLE captured frame; a region is a window onto it, not a
  // smaller capture of the same screen.
  const frame = crop?.frame ?? video;
  const ox = crop?.x ?? 0;
  const oy = crop?.y ?? 0;

  // The rectangle the pointer's coordinates are measured against. With a
  // recorded surface it is that surface, moment by moment — which is what makes
  // a window share, a second monitor and a window someone dragged mid-take all
  // work. Without one it is the whole main screen, which is what every
  // recording assumed before surfaces existed.
  const bounds = insetBounds(rec.bounds, inset);
  const fallback: CursorBounds =
    rec.screen.width > 0 && rec.screen.height > 0
      ? { t: 0, x: 0, y: 0, w: rec.screen.width, h: rec.screen.height }
      : // A helper that could not read the screen at all. Passing the
        // coordinates through unscaled is the only guess available, and it is
        // right whenever the capture is at the display's own resolution.
        { t: 0, x: 0, y: 0, w: frame.width, h: frame.height };

  const samples: CursorSample[] = [];
  // Bounds are in ascending time and there are a handful of them, so walking a
  // cursor forward alongside the samples costs nothing — a lookup per sample
  // would be quadratic on a long take with a restless window.
  let bi = 0;
  for (const s of rec.samples) {
    const t = s.t - videoStartedAt;
    if (t < 0) continue;
    while (bi + 1 < bounds.length && bounds[bi + 1].t <= s.t) bi++;
    const b = bounds.length ? bounds[bi] : fallback;
    if (!(b.w > 0 && b.h > 0)) continue;
    // Fraction of the surface, then pixels of the captured frame. Going through
    // fractions is what makes this indifferent to the pixels-per-point gap: the
    // surface is measured in points, the video in pixels, and neither number
    // appears in the result.
    const x = Math.round(((s.x - b.x) / b.w) * frame.width) - ox;
    const y = Math.round(((s.y - b.y) / b.h) * frame.height) - oy;
    // A pointer outside the recorded region has no position in this video —
    // which now includes the pointer being outside the WINDOW being recorded,
    // the common and correct case of reaching for something else mid-take.
    // Keeping it would place the highlight outside the clip's box, drawing it
    // over whatever else is on the canvas; dropping it holds the last position
    // inside the region instead, which is where the pointer was last seen.
    if (x < 0 || y < 0 || x > video.width || y > video.height) continue;
    const out: CursorSample = { t: Math.round(t), x, y };
    if (s.down) out.down = s.down;
    // The shape rides along untouched — it is the one thing here that needs no
    // coordinate conversion, because it says nothing about where anything is.
    if (s.k) out.k = s.k;
    samples.push(out);
  }
  return {
    version: 1,
    video,
    clicks: rec.clicks,
    kinds: rec.kinds,
    hidden: cursorHidden,
    samples,
  };
}

/**
 * Shrink each recorded rectangle to the part actually captured.
 *
 * Only a tab share needs this: cursord tracks the browser *window* and the
 * recording is its web contents. Applied per sample rather than once, so the
 * viewport travels with a window that is moved.
 */
function insetBounds(bounds: CursorBounds[] | undefined, inset?: SurfaceInset): CursorBounds[] {
  if (!bounds?.length) return [];
  if (!inset || (!inset.left && !inset.top && !inset.right && !inset.bottom)) return bounds;
  return bounds.map((b) => ({
    t: b.t,
    x: b.x + inset.left,
    y: b.y + inset.top,
    w: Math.max(1, b.w - inset.left - inset.right),
    h: Math.max(1, b.h - inset.top - inset.bottom),
  }));
}
