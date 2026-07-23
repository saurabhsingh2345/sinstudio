# cursord — pointer tracking for screen recordings

Optional helper that records where the pointer is and when it is clicked, so
Studio can add cursor highlights, spotlights and click rings to a screen
recording afterwards.

**Studio works without it.** You get the recording; you don't get cursor
effects. Nothing else changes.

## Why it exists

Neither half of Studio can see the pointer:

- The **browser** gets pixels from `getDisplayMedia` and no coordinates. The
  cursor is painted into the frame, not reported — and a tab can't observe
  anything outside itself anyway.
- The **backend** could ask the OS, but it may be in a container or on another
  machine, where "the pointer" isn't your pointer.

So this is a third piece: a small binary on the same machine as the browser,
which is the only vantage point that can see both your screen and your input.

It is a **separate Go module** on purpose. It needs cgo and per-OS code; the
backend is built `CGO_ENABLED=0` with no platform files, and that stays true.

## Running it

```sh
cd tools/cursord
go run .                 # listens on 127.0.0.1:8791
```

Then open Studio's **Record** panel — "Cursor tracking" appears once the helper
is detected. Leave it running for as long as you're recording.

To build a binary you can start from anywhere:

```sh
go build -o ~/bin/cursord ./tools/cursord
```

## Permissions

On macOS, **none.** Position comes from `CGEventCreate`, and button state from
`CGEventSourceButtonState` — neither needs an Accessibility grant, unlike
installing an event tap. If you are ever asked to approve something, that is not
this program.

On **Windows**, no special permissions — `GetCursorPos` and `GetAsyncKeyState`
read the pointer directly. Build on Windows with `go build` in this directory.

On **Linux**, tracking is not implemented yet (`/health` reports `supported: false`).

## What it records

Polls at 60 Hz, and keeps a sample when the pointer moved, a button changed, or
250 ms passed. A still pointer therefore costs ~4 samples/second instead of 60 —
a long tutorial is mostly a still pointer, and this is the difference between a
~100 KB sidecar and a multi-megabyte one, with nothing lost: the gaps are exactly
the spans where nothing changed.

It records **pointer position and mouse buttons only** — no keystrokes, no window
contents, no clipboard.

## Privacy and network posture

This process can see where you point and when you click, continuously. So:

- It binds **loopback only** and refuses to start on any other interface.
- It answers only pages served from `localhost` / `127.0.0.1` / `::1`, on any
  port. A page from anywhere else cannot start tracking or read a session.
- It keeps one session in memory and hands it over on `/stop`. Nothing is
  written to disk here — Studio stores the result beside the recording it
  belongs to.

Run it while you're recording, stop it when you're done.

## API

| Method | Path      | Purpose |
|--------|-----------|---------|
| `GET`  | `/health` | Presence, platform, whether clicks are visible, screen size |
| `POST` | `/start`  | Begin a session, discarding any previous one |
| `POST` | `/stop`   | End it and return the samples |

Sample timestamps are **absolute epoch milliseconds**, deliberately. Studio
aligns them against the moment its recorder actually started, which it can't
know in advance and which doesn't coincide with when tracking began. Both clocks
are this machine's, so the subtraction is exact.

```jsonc
// POST /stop
{
  "ok": true,
  "recording": {
    "version": 1,
    "startedAt": 1784630967841,
    "stoppedAt": 1784630985424,
    "screen": { "width": 1728, "height": 1117 },
    "clicks": true,          // false = buttons couldn't be observed at all,
                             // which is not the same as "no clicks happened"
    "samples": [
      { "t": 1784630967841, "x": 135, "y": 607 },
      { "t": 1784630967858, "x": 200, "y": 200, "down": 1 }  // 1 = left, 2 = right
    ]
  }
}
```

## Coordinates, and the one real limitation

Samples are in whole-screen coordinates. They can only be placed on a video that
**is** the whole screen, so cursor effects require sharing an entire display.

Sharing a window or a browser tab produces a video whose origin is that
surface's top-left, at an offset a browser tab has no way to learn. Studio
detects this (`displaySurface`) and declines to attach the data rather than
guessing — a wrong offset would misplace every highlight by a varying amount,
which is worse than not offering the feature.

Scaling is handled: a display reported at 1728 wide but captured at 3456, or
constrained down to 1280, maps correctly either way.

## Other platforms

macOS works today. `cursor_other.go` is a stub so the helper still builds, runs
and answers `/health` elsewhere — reporting `supported: false`, which Studio
reads to hide the feature rather than offering something that silently records
nothing.

Adding a platform means implementing four functions in a new build-tagged file:

- **Windows** — `GetCursorPos`, plus `GetAsyncKeyState(VK_LBUTTON/VK_RBUTTON)`
- **Linux/X11** — `XQueryPointer` returns position and button mask together
