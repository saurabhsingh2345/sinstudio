import { describe, it, expect } from "vitest";
import { insetFor, matchSurface, surfaceLabel, type CaptureShape } from "./surfaceMatch";
import type { CursorSurface } from "./cursor";

const display = (id: number, x: number, y: number, w: number, h: number, front = 0): CursorSurface => ({
  id: `display:${id}`,
  kind: "display",
  app: "Display",
  title: id === 1 ? "Main display" : `Display ${id}`,
  rect: { x, y, w, h },
  front,
});

const win = (
  id: number,
  app: string,
  x: number,
  y: number,
  w: number,
  h: number,
  front = 0
): CursorSurface => ({ id: `window:${id}`, kind: "window", app, title: "", rect: { x, y, w, h }, front });

const cap = (over: Partial<CaptureShape>): CaptureShape => ({
  surface: "window",
  width: 0,
  height: 0,
  dpr: 2,
  ...over,
});

describe("matchSurface — displays", () => {
  // The case that always worked, and must keep working identically.
  it("finds the main display behind a Retina whole-screen capture", () => {
    const m = matchSurface([display(1, 0, 0, 1728, 1117)], cap({ surface: "monitor", width: 3456, height: 2234 }));
    expect(m?.surface.id).toBe("display:1");
    expect(m?.ambiguous).toBe(false);
  });

  /*
   * The bug nobody was looking for. cursord reported only the MAIN display's
   * size and the old conversion scaled against it, so a second monitor of a
   * different shape placed every effect somewhere the pointer never was — and
   * it did so silently, because a whole-screen share was the one case Studio
   * was confident about.
   */
  it("picks the second monitor, not the main one, when that is what was shared", () => {
    const m = matchSurface(
      [display(1, 0, 0, 1728, 1117), display(2, 1728, 0, 2560, 1440, 1)],
      cap({ surface: "monitor", width: 2560, height: 1440, dpr: 1 })
    );
    expect(m?.surface.id).toBe("display:2");
    expect(m?.surface.rect.x).toBe(1728);
  });
});

describe("matchSurface — windows", () => {
  it("matches a window by shape regardless of capture scale", () => {
    const m = matchSurface(
      [win(11, "Terminal", 100, 200, 800, 600), win(12, "Finder", 0, 0, 1200, 400, 1)],
      cap({ width: 1600, height: 1200 })
    );
    expect(m?.surface.id).toBe("window:11");
    expect(m?.inset).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  // A share whose shape matches nothing on screen must not be forced onto the
  // nearest thing. Refusing gives a recording with no cursor effects; guessing
  // gives one with cursor effects in the wrong place, which looks like a bug in
  // the zoom rather than a failure to identify a window.
  it("returns null rather than forcing a poor match", () => {
    const m = matchSurface([win(11, "Terminal", 0, 0, 800, 600)], cap({ width: 1000, height: 200 }));
    expect(m).toBeNull();
  });

  it("reports ambiguity when two windows are the same shape", () => {
    const m = matchSurface(
      [win(11, "Terminal", 0, 0, 800, 600, 3), win(12, "Notes", 900, 0, 800, 600, 1)],
      cap({ width: 1600, height: 1200 })
    );
    expect(m?.ambiguous).toBe(true);
    // Front-most breaks the tie, and both stay available for correction.
    expect(m?.surface.id).toBe("window:12");
    expect(m?.candidates).toHaveLength(2);
  });

  // Same shape, different scale: 800x600 captured at 1600x1200 is a 2x Retina
  // window; the 1600x1200 window would have to have been captured at 1x. Both
  // are plausible, so this stays ambiguous — but the 2x reading is offered
  // first on a machine whose own windows are drawn at 2x.
  it("prefers the candidate whose implied scale matches the display", () => {
    const m = matchSurface(
      [win(11, "Terminal", 0, 0, 1600, 1200, 0), win(12, "Notes", 0, 0, 800, 600, 1)],
      cap({ width: 1600, height: 1200, dpr: 2 })
    );
    expect(m?.surface.id).toBe("window:12");
  });

  it("never offers a display for a window share, or the reverse", () => {
    const surfaces = [display(1, 0, 0, 1600, 1200), win(11, "Terminal", 0, 0, 1600, 1200)];
    expect(matchSurface(surfaces, cap({ surface: "window", width: 1600, height: 1200, dpr: 1 }))?.surface.kind).toBe(
      "window"
    );
    expect(matchSurface(surfaces, cap({ surface: "monitor", width: 1600, height: 1200, dpr: 1 }))?.surface.kind).toBe(
      "display"
    );
  });
});

describe("matchSurface — tabs", () => {
  /*
   * A tab is a rectangle inside a browser window that the OS cannot name. The
   * window is found by width — browser furniture spans the full width — and the
   * viewport is anchored to the bottom, because that is where web contents sit
   * under a tab strip and a toolbar.
   */
  it("insets a tab's viewport below the browser's toolbar", () => {
    const m = matchSurface(
      [win(20, "Google Chrome", 40, 60, 1400, 900)],
      cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 })
    );
    expect(m?.surface.id).toBe("window:20");
    // 1600px of viewport at 2x is 800pt inside a 900pt window: 100pt of chrome.
    expect(m?.inset).toEqual({ left: 0, top: 100, right: 0, bottom: 0 });
  });

  it("ignores windows that aren't a browser's", () => {
    const m = matchSurface(
      [win(21, "Terminal", 0, 0, 1400, 900)],
      cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 })
    );
    expect(m).toBeNull();
  });

  // A viewport cannot be taller than the window containing it, and a window
  // twice the height of its own web contents is a different window that happens
  // to be the same width.
  it("rejects windows the viewport could not fit inside", () => {
    const tooShort = matchSurface(
      [win(20, "Google Chrome", 0, 0, 1400, 700)],
      cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 })
    );
    expect(tooShort).toBeNull();
    const tooTall = matchSurface(
      [win(20, "Google Chrome", 0, 0, 1400, 3000)],
      cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 })
    );
    expect(tooTall).toBeNull();
  });

  it("says a tab match is uncertain when several browser windows are open", () => {
    const m = matchSurface(
      [win(20, "Google Chrome", 0, 0, 1400, 900), win(21, "Google Chrome", 20, 20, 1400, 950, 1)],
      cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 })
    );
    expect(m?.ambiguous).toBe(true);
  });
});

describe("insetFor", () => {
  it("re-derives a tab's inset when the user corrects the window", () => {
    const other = win(22, "Google Chrome", 0, 0, 1400, 1000);
    const shape = cap({ surface: "browser", width: 2800, height: 1600, dpr: 2 });
    expect(insetFor(other, shape)).toEqual({ left: 0, top: 200, right: 0, bottom: 0 });
  });

  it("is empty for anything that is not a tab", () => {
    expect(insetFor(win(11, "Terminal", 0, 0, 800, 600), cap({ width: 800, height: 600 }))).toEqual({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
  });
});

describe("surfaceLabel", () => {
  it("names a window by its app when the OS withheld the title", () => {
    expect(surfaceLabel(win(11, "Terminal", 0, 0, 800, 600))).toBe("Terminal");
    expect(surfaceLabel({ ...win(11, "Terminal", 0, 0, 800, 600), title: "zsh" })).toBe("Terminal — zsh");
    expect(surfaceLabel(display(1, 0, 0, 1728, 1117))).toBe("Main display");
  });
});
