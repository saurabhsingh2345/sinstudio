// Talks to cursord, the optional local helper that records pointer position
// and clicks during a screen capture (tools/cursord).
//
// The browser is the right side of this conversation even though the backend
// is where sidecars end up: cursord has to run on the machine being recorded,
// and the backend may not be that machine. The tab is.
//
// Everything here degrades. If the helper is not running you still get the
// recording, just without the data cursor effects need.

export const CURSORD_ORIGIN = "http://127.0.0.1:8791";

export interface CursorHealth {
  ok: boolean;
  platform: string;
  supported: boolean;
  clicks: boolean;
  screen: { width: number; height: number };
}

export interface CursorSample {
  t: number; // epoch ms
  x: number;
  y: number;
  down?: number; // 1 = left, 2 = right (bitmask)
}

export interface CursorRecording {
  version: number;
  startedAt: number;
  stoppedAt: number;
  screen: { width: number; height: number };
  samples: CursorSample[];
  clicks: boolean;
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

/**
 * Whether pointer coordinates can be placed in this recording's frame.
 *
 * cursord reports the pointer in whole-screen coordinates. That maps onto the
 * video only when the video *is* the whole screen. Sharing a window or a tab
 * gives a video whose origin is that surface's top-left, at an offset we have
 * no way to learn from inside the tab — so the honest answer there is no, and
 * the alternative (assuming an offset) would misplace every highlight by a
 * variable amount rather than failing visibly.
 */
export function canMapToVideo(surface: string | undefined): boolean {
  return surface === "monitor";
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
  crop?: CaptureCrop
): CursorSidecar {
  // Scale against the WHOLE captured frame; a region is a window onto it, not a
  // smaller capture of the same screen.
  const frame = crop?.frame ?? video;
  const sx = rec.screen.width > 0 ? frame.width / rec.screen.width : 1;
  const sy = rec.screen.height > 0 ? frame.height / rec.screen.height : 1;
  const ox = crop?.x ?? 0;
  const oy = crop?.y ?? 0;

  const samples: CursorSample[] = [];
  for (const s of rec.samples) {
    const t = s.t - videoStartedAt;
    if (t < 0) continue;
    const x = Math.round(s.x * sx) - ox;
    const y = Math.round(s.y * sy) - oy;
    // A pointer outside the recorded region has no position in this video.
    // Keeping it would place the highlight outside the clip's box, drawing it
    // over whatever else is on the canvas; dropping it holds the last position
    // inside the region instead, which is where the pointer was last seen.
    if (x < 0 || y < 0 || x > video.width || y > video.height) continue;
    const out: CursorSample = { t: Math.round(t), x, y };
    if (s.down) out.down = s.down;
    samples.push(out);
  }
  return { version: 1, video, clicks: rec.clicks, hidden: cursorHidden, samples };
}
