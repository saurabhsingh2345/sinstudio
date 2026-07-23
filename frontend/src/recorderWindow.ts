/*
The floating recorder controls.

A screen recording is, by definition, made while looking at something other than
Studio. So the Record panel — the thing holding Stop — is behind whatever is
being recorded for the entire take. The only ways out are to stop from the
browser's own sharing bar, which we do not own and which offers nothing else, or
to switch back to the tab, which lands in the recording.

A browser tab cannot draw over other applications, so an in-page widget cannot
solve this however it is styled. Document Picture-in-Picture can: it is a real
window, owned by the page, that floats above everything and survives the tab
being hidden. Rendering DOM into it is the whole point of the API.

Built from plain DOM with inline styles rather than the app's components. A PiP
window is a separate document with its own empty stylesheet, so Tailwind classes
resolve to nothing; the alternative is copying every stylesheet across at open
time, which throws on any cross-origin sheet and silently half-styles the rest.
Four elements do not justify that.
*/

/** Chrome's Document PiP, which TypeScript's DOM lib does not declare. */
declare global {
  interface DocumentPictureInPictureOptions {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }
  interface DocumentPictureInPicture extends EventTarget {
    requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
    readonly window: Window | null;
  }
  // eslint-disable-next-line no-var
  var documentPictureInPicture: DocumentPictureInPicture | undefined;
}

/**
 * mm:ss for the take's running time.
 *
 * Clamped at zero because elapsed is derived by subtracting a start timestamp,
 * and a clock that has just been set backwards would otherwise render "-1:-3"
 * on the one control the user is watching.
 */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function isFloatingControlsSupported(): boolean {
  const pip = (globalThis as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
  return typeof pip?.requestWindow === "function";
}

export interface FloatingControls {
  setElapsed(seconds: number): void;
  setPaused(paused: boolean): void;
  /** True once the window has gone, however it went. */
  readonly closed: boolean;
  close(): void;
}

export interface FloatingHandlers {
  onPause(): void;
  onResume(): void;
  onStop(): void;
}

const BG = "#141518";
const FG = "#f4f4f5";
const DIM = "#a1a1aa";

function button(doc: Document, label: string, title: string, accent?: string) {
  const b = doc.createElement("button");
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  Object.assign(b.style, {
    font: "500 12px system-ui, -apple-system, sans-serif",
    color: accent ? "#fff" : FG,
    background: accent ?? "rgba(255,255,255,0.10)",
    border: "none",
    borderRadius: "7px",
    padding: "7px 13px",
    cursor: "pointer",
    lineHeight: "1",
  } satisfies Partial<CSSStyleDeclaration>);
  return b;
}

/**
 * Open the floating controls.
 *
 * MUST be called from within a user gesture, before anything is awaited.
 * requestWindow needs transient activation, and the screen-share picker
 * outlives it — a window opened after the share is granted is refused, which is
 * why this is opened first and torn down if the recording never starts.
 *
 * Returns null when unsupported or refused. The controls are a convenience on
 * top of a recording that works without them; never let this fail a take.
 */
export async function openFloatingControls(handlers: FloatingHandlers): Promise<FloatingControls | null> {
  if (!isFloatingControlsSupported()) return null;

  let win: Window;
  try {
    // Height is the OUTER window, and Chrome puts its own header on a PiP
    // window which comes out of the middle: 92 was requested and left a 36px
    // viewport, crushing the controls together. 132 leaves ~76. The layout
    // survives a short viewport regardless, since the header is not ours to
    // measure and differs by platform.
    win = await documentPictureInPicture!.requestWindow({ width: 340, height: 132 });
  } catch {
    return null;
  }

  const doc = win.document;
  doc.title = "Recording";
  Object.assign(doc.body.style, {
    margin: "0",
    // 100vh, not 100%: a percentage height resolves against <html>, which has
    // no height of its own in a blank document, so the body collapses to its
    // content and align-items has nothing to centre within. The controls then
    // sit against the top edge with the rest of the window empty below them.
    height: "100vh",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "0 14px",
    background: BG,
    color: FG,
    font: "13px system-ui, -apple-system, sans-serif",
    // The window is dragged by its own chrome, so nothing inside should look
    // selectable — a text cursor over a control bar reads as broken.
    userSelect: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const dot = doc.createElement("span");
  Object.assign(dot.style, {
    width: "9px",
    height: "9px",
    borderRadius: "50%",
    background: "#ef4444",
    flex: "0 0 auto",
  } satisfies Partial<CSSStyleDeclaration>);
  const style = doc.createElement("style");
  // The pulse is what distinguishes recording from paused at a glance, from
  // across a desk, without reading anything.
  style.textContent = `@keyframes rec{0%,100%{opacity:1}50%{opacity:.25}}`;
  doc.head.appendChild(style);
  dot.style.animation = "rec 1.4s ease-in-out infinite";

  const time = doc.createElement("span");
  time.textContent = "00:00";
  Object.assign(time.style, {
    font: "600 15px ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.5px",
    flex: "0 0 auto",
    minWidth: "52px",
  } satisfies Partial<CSSStyleDeclaration>);

  const state = doc.createElement("span");
  state.textContent = "recording";
  Object.assign(state.style, { color: DIM, fontSize: "11px", flex: "1 1 auto" } satisfies Partial<CSSStyleDeclaration>);

  const pause = button(doc, "Pause", "Pause the recording");
  const stop = button(doc, "Stop", "Stop and save the recording", "#dc2626");

  let paused = false;
  pause.onclick = () => (paused ? handlers.onResume() : handlers.onPause());
  stop.onclick = () => handlers.onStop();

  doc.body.append(dot, time, state, pause, stop);

  let closed = false;
  win.addEventListener("pagehide", () => {
    closed = true;
  });

  return {
    get closed() {
      return closed || win.closed;
    },
    setElapsed(seconds) {
      if (closed || win.closed) return;
      time.textContent = formatElapsed(seconds);
    },
    setPaused(p) {
      if (closed || win.closed) return;
      paused = p;
      pause.textContent = p ? "Resume" : "Pause";
      state.textContent = p ? "paused" : "recording";
      dot.style.animation = p ? "none" : "rec 1.4s ease-in-out infinite";
      dot.style.opacity = p ? "0.4" : "1";
    },
    close() {
      closed = true;
      try {
        win.close();
      } catch {
        /* already gone */
      }
    },
  };
}
