// Which of the machine's windows or displays is the share we were just handed?
//
// getDisplayMedia tells a tab almost nothing about what it granted: a size, and
// one of three words — "monitor", "window", "browser". It will not say which
// monitor, which window, or where on the screen any of it is. cursord can
// enumerate every display and window with its rectangle, but it cannot see
// what the browser's picker did. Neither side knows; between them the answer is
// determined, and this is where the two are joined.
//
// The join is aspect ratio, because it is the one property that survives the
// trip. Sizes do not: a capture arrives in pixels while the operating system
// reports points, so a Retina window is 2x its own rectangle, and Chrome will
// additionally downscale a large share to stay inside its encoder limits. A
// ratio is immune to every one of those.
//
// Where the ratio alone cannot decide — two windows the same shape — the match
// is reported as ambiguous rather than guessed at confidently. The recorder
// shows the pick and lets it be corrected, which is cheap; silently mapping
// pointer data through the wrong window is not.

import type { CursorSurface } from "./cursor";

/** What getDisplayMedia handed over: the surface word, and the frame size. */
export interface CaptureShape {
  /** displaySurface from the track: "monitor" | "window" | "browser". */
  surface: string | undefined;
  width: number;
  height: number;
  /**
   * The scale the browser's own window is being drawn at. Only a hint — the
   * share may be on a different display — but a strong one, and it is the only
   * pixels-per-point figure a tab can observe at all.
   */
  dpr?: number;
}

/**
 * Trim taken off the matched surface to reach the thing actually recorded.
 *
 * Only a tab share needs one. cursord can see a browser *window*; the recording
 * is that window's web contents, which is the window minus its toolbar. The
 * inset is in the surface's own units and is applied to every bounds sample, so
 * a window that moves carries its viewport with it.
 */
export interface SurfaceInset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_INSET: SurfaceInset = { left: 0, top: 0, right: 0, bottom: 0 };

export interface SurfaceMatch {
  surface: CursorSurface;
  inset: SurfaceInset;
  /**
   * True when another candidate fitted about as well. The recording still gets
   * mapped — a probable answer beats no cursor effects — but the UI says which
   * surface it chose and offers the alternatives.
   */
  ambiguous: boolean;
  /** Every plausible candidate, best first, for that correction menu. */
  candidates: CursorSurface[];
}

/**
 * Applications whose windows can contain a capturable tab.
 *
 * Matched against cursord's owner name, which macOS reports without any
 * permission grant — unlike the window title, which is usually empty.
 */
const BROWSER_APPS = [
  "google chrome",
  "chromium",
  "microsoft edge",
  "brave browser",
  "arc",
  "safari",
  "firefox",
  "vivaldi",
  "opera",
  "comet",
  "dia",
];

const isBrowser = (app: string) => {
  const a = app.toLowerCase();
  return BROWSER_APPS.some((b) => a.includes(b));
};

/**
 * How far two aspect ratios may differ and still be the same thing.
 *
 * Capture pipelines round to even dimensions and sometimes to a multiple of
 * four, so an exact match is not available even in the ideal case: a 1728x1117
 * window captured at 3456x2234 is a hair off its own ratio. 1.5% absorbs that
 * and nothing else — the next window up or down in a tiled layout is further
 * away than this.
 */
const ASPECT_TOLERANCE = 0.015;

/** Relative difference between two ratios, symmetric in their order. */
const aspectError = (a: number, b: number) => (a <= 0 || b <= 0 ? Infinity : Math.abs(a - b) / Math.min(a, b));

/**
 * How believable a pixels-per-point figure is.
 *
 * A capture is its surface at the display's own scale, so the browser's own
 * devicePixelRatio is the reading to beat and scores zero. Plain 1x and 2x are
 * next, because the share may be on a second display of a different density;
 * they carry a small floor so they lose to an exact match rather than tying
 * with it — which is the difference between choosing an 800pt window on a 2x
 * screen and a 1600pt one that would have had to be captured at half density.
 *
 * Nothing is rejected outright: a browser is allowed to downscale a large share
 * to stay inside its encoder limits, and that is a weaker reading, not a wrong
 * one.
 */
function scalePenalty(scale: number, dpr: number): number {
  const plausible: [value: number, floor: number][] = [
    [dpr, 0],
    [1, 0.02],
    [2, 0.02],
    [1.5, 0.05],
    [3, 0.05],
  ];
  return Math.min(...plausible.filter(([p]) => p > 0).map(([p, floor]) => floor + Math.abs(scale - p) / p));
}

/**
 * Match a granted share against the surfaces cursord can see.
 *
 * Returns null when nothing fits, which is a real and acceptable answer: an
 * unrecognised share keeps today's behaviour of recording fine and skipping the
 * cursor effects, rather than placing them through a rectangle that isn't the
 * one on screen.
 */
export function matchSurface(surfaces: CursorSurface[], cap: CaptureShape): SurfaceMatch | null {
  if (!surfaces.length || cap.width <= 0 || cap.height <= 0) return null;
  const dpr = cap.dpr && cap.dpr > 0 ? cap.dpr : 1;
  const want = cap.width / cap.height;

  if (cap.surface === "browser") return matchTab(surfaces, cap, dpr);

  const pool = surfaces.filter((s) => (cap.surface === "monitor" ? s.kind === "display" : s.kind === "window"));
  const scored = pool
    .map((s) => ({
      s,
      err: aspectError(s.rect.w / s.rect.h, want),
      scale: s.rect.w > 0 ? cap.width / s.rect.w : 0,
    }))
    .filter((c) => c.err <= ASPECT_TOLERANCE)
    // Aspect decides first. Among windows that are genuinely the same shape,
    // the one captured at a believable scale wins, and only then does stacking
    // order break the tie — the window you just picked is usually near the
    // front, but "usually" is not something to rank above measurement.
    .sort(
      (a, b) =>
        a.err - b.err ||
        scalePenalty(a.scale, dpr) - scalePenalty(b.scale, dpr) ||
        a.s.front - b.s.front
    );

  if (!scored.length) return null;
  const best = scored[0];
  const runnerUp = scored[1];
  // Ambiguous only when a rival is BOTH as good a shape and as good a scale.
  // Two same-shaped windows at different scales are not really a tie.
  const ambiguous =
    !!runnerUp &&
    Math.abs(runnerUp.err - best.err) < ASPECT_TOLERANCE / 2 &&
    Math.abs(scalePenalty(runnerUp.scale, dpr) - scalePenalty(best.scale, dpr)) < 0.05;

  return {
    surface: best.s,
    inset: NO_INSET,
    ambiguous,
    candidates: scored.map((c) => c.s),
  };
}

/**
 * A tab is a rectangle inside a browser window that the operating system does
 * not name.
 *
 * Chrome captures a tab's *web contents*: the window minus its tab strip and
 * toolbar, and minus a side panel if one is open. So the window is found by its
 * width — chrome furniture spans the full width, so the viewport is exactly as
 * wide as the window unless a panel is open — and the viewport is then anchored
 * to the window's bottom-left corner, which is where web contents live.
 *
 * That anchoring is an assumption, and it is wrong in one case worth naming:
 * developer tools docked along the BOTTOM push the viewport upward. Nothing
 * observable distinguishes that from a shorter window, so the recorder reports
 * a tab match as an estimate rather than a certainty.
 */
function matchTab(surfaces: CursorSurface[], cap: CaptureShape, dpr: number): SurfaceMatch | null {
  const windows = surfaces.filter((s) => s.kind === "window" && isBrowser(s.app || ""));
  if (!windows.length) return null;

  const scored: { s: CursorSurface; inset: SurfaceInset; err: number; front: number }[] = [];
  for (const s of windows) {
    // The scale is fixed by the width, which viewport and window share. Height
    // then converts through the same scale, and the leftover is the toolbar.
    const scale = cap.width / s.rect.w;
    if (!(scale > 0)) continue;
    const viewH = cap.height / scale;
    const chrome = s.rect.h - viewH;
    // Negative means the "viewport" is taller than the window it is supposedly
    // inside — not this window. A huge value means the window dwarfs the
    // capture, which is a different window at a coincidental width.
    if (chrome < 0 || chrome > s.rect.h * 0.5) continue;
    scored.push({
      s,
      inset: { left: 0, top: chrome, right: 0, bottom: 0 },
      // How far the implied scale is from something a display actually uses.
      // For a tab this carries the whole burden of identification, since every
      // browser window is a plausible container for a viewport of some shape.
      err: scalePenalty(scale, dpr),
      front: s.front,
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.err - b.err || a.front - b.front);

  const best = scored[0];
  return {
    surface: best.s,
    inset: best.inset,
    // A tab is always reported as uncertain when more than one browser window
    // is open, because the evidence genuinely cannot separate them.
    ambiguous: scored.length > 1,
    candidates: scored.map((c) => c.s),
  };
}

/** The inset for a given window, recomputed when the user corrects the pick. */
export function insetFor(surface: CursorSurface, cap: CaptureShape): SurfaceInset {
  if (cap.surface !== "browser" || surface.kind !== "window" || surface.rect.w <= 0) return NO_INSET;
  const scale = cap.width / surface.rect.w;
  if (!(scale > 0)) return NO_INSET;
  const chrome = Math.max(0, surface.rect.h - cap.height / scale);
  return { left: 0, top: chrome, right: 0, bottom: 0 };
}

/** A human label for a surface, for the "tracking this one" line. */
export function surfaceLabel(s: CursorSurface): string {
  if (s.kind === "display") return s.title || "Display";
  const name = s.title || s.app || "Window";
  return s.title && s.app ? `${s.app} — ${s.title}` : name;
}
