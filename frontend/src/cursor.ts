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
 * Convert a cursord session into a sidecar aligned to one recorded track.
 *
 * `videoStartedAt` is when that MediaRecorder actually began — cursord starts
 * earlier (we ask it first so no motion is missed), so samples before frame
 * zero are dropped rather than given negative timestamps.
 *
 * Scaling handles the display-vs-capture resolution gap: a Retina screen
 * reported at 1728 wide may be captured at 1728 or 3456, and a constrained
 * capture may be smaller than either.
 */
export function toSidecar(
  rec: CursorRecording,
  videoStartedAt: number,
  video: { width: number; height: number },
  cursorHidden = false
): CursorSidecar {
  const sx = rec.screen.width > 0 ? video.width / rec.screen.width : 1;
  const sy = rec.screen.height > 0 ? video.height / rec.screen.height : 1;

  const samples: CursorSample[] = [];
  for (const s of rec.samples) {
    const t = s.t - videoStartedAt;
    if (t < 0) continue;
    const out: CursorSample = { t: Math.round(t), x: Math.round(s.x * sx), y: Math.round(s.y * sy) };
    if (s.down) out.down = s.down;
    samples.push(out);
  }
  return { version: 1, video, clicks: rec.clicks, hidden: cursorHidden, samples };
}
