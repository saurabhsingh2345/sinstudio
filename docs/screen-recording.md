# Screen recording

Studio records your screen and edits the result like a camera operator would
have shot it: pushing in where you clicked, drifting to follow you, pulling back
when you move on. None of that is a filter applied afterwards — it is ordinary
keyframes on the clip, so every move it guesses can be dragged, retimed or
deleted.

This document is about the recorder. For the editor generally, see the root
`README.md`.

---

## Recording

Open a project → **Media → Record**.

| Source | What it does |
| --- | --- |
| **Screen** | The browser asks which display, window or tab to share. |
| **Just a region** | Records a rectangle of the share instead of all of it. |
| **Camera** | Lands on the overlay track, ready to be framed as picture-in-picture. |
| **Microphone** | Its own audio track, so narration stays adjustable against everything else. |
| **System audio** | The sound the machine is making. Chrome only, and only alongside a tab or window share. |

Every source becomes its **own clip**, aligned to the moment it actually started.
Narration and picture stay in sync, but you can cut, move and level them apart.
One muxed file would be simpler to produce and much worse to edit.

### Floating controls

While recording, a small always-on-top window carries the elapsed time, Pause
and Stop. It stays visible over whatever you are recording, so you never have to
come back to the Studio tab — which would put Studio in your own recording.

It uses Document Picture-in-Picture (Chrome/Edge). Where that is unavailable the
recorder works exactly as before, minus the floating window; the panel's own
Stop button still ends the take.

Closing the floating window does **not** stop the recording. Closing a control
panel should not destroy what is being recorded.

### Region recording

Choose **Just a region**, pick your share, then drag a rectangle over the live
preview of it. The size you will actually get is shown as you drag.

The crop happens **before the first frame is encoded**, so the file, the upload
and every later decode all shrink with it. This is the one thing that cannot be
done afterwards — cropping at export time is arithmetically identical to a
static zoom, which the Zoom & Pan panel already does.

Needs Insertable Streams (Chrome/Edge). There is deliberately **no fallback**:
the obvious alternative, drawing frames to a canvas, is driven by
`requestAnimationFrame`, which stops in a backgrounded tab — and a screen
recorder's tab is backgrounded by definition, because you are looking at the
thing being recorded. That version records a few seconds and then a
freeze-frame. A feature that fails exactly when it is used is worse than one
that is honestly absent.

---

## Cursor tracking

A browser tab gets pixels from `getDisplayMedia` and no coordinates — the cursor
is painted into the frame, not reported — and it cannot observe anything outside
itself anyway. The Go backend could ask the operating system, but it may be in a
container or on another machine, where "the pointer" is not your pointer.

So pointer data comes from **`cursord`**, a small optional helper that runs on
the same machine as the browser:

```sh
cd tools/cursord && go build && ./cursord
```

It listens on `127.0.0.1:8791`, answers only localhost origins, writes nothing to
disk, and records position and button state at 60Hz — keeping a sample only when
the pointer moved, a button changed, or 250ms passed. A tutorial is mostly a
motionless pointer, so a session is typically ~100KB rather than several
megabytes.

Studio probes for it and works without it. You get the recording; you do not get
the cursor effects or the automatic camera work.

**Share a whole screen.** `cursord` reports the pointer in screen coordinates,
which map onto the video only when the video *is* the screen. A window or tab
share has an origin no browser tab can learn, so Studio declines to attach the
data rather than misplacing every effect by an unknown offset. It says so when
this happens.

### Studio draws the cursor

With this on, the capture is asked to exclude the real cursor and Studio draws
its own from the recorded track. That is what makes the pointer editable at all
— resizable, recolourable, smoothable — because a cursor burned into the pixels
is wherever it was, at whatever size the OS drew it.

The constraint is optional in the spec and browsers may ignore it, so what
actually happened is read back off the track rather than assumed. It is only
offered when tracking is running: hiding the cursor with nothing recording its
position produces a video with no cursor at all.

---

## What happens when a recording lands

Automatically, as the clip hits the timeline:

1. **The canvas takes the shape of your screen.** Only for the first clip in a
   project — after that the canvas is a decision you have made. A 3:2 laptop
   recorded into a 16:9 project would otherwise sit in black bars.
2. **Zooms are found and written**, from where you clicked and where you paused.
3. **Click rings** are switched on.

All of it is one undo away, and every keyframe stays draggable. The cursor
*highlight* — a soft disc that follows the pointer — is deliberately **not**
automatic: it glows over the content on every frame whether anything is
happening or not, which reads as a smudge trailing the cursor rather than as
emphasis. It is one toggle away in **Cursor Effects**.

---

## How the camera decides

In the clip inspector under **Auto Zoom**. Re-run it any time, tune it, or clear
it.

### What it looks for

- **Clicks.** The strongest signal: something happened *here*. Fires on press
  edges, so a held button is one click rather than sixty.
- **Pauses.** A parked pointer is usually pointing at something. Measured
  against where the pause began, not a running average — an average follows a
  slow drift and never breaks, turning a whole recording into one long "pause".

Events close in both time and space merge, so three clicks on one button are one
zoom rather than three.

### Returning somewhere pushes further

Coming back to a place is the strongest statement a recording makes about what
matters in it — the difference between passing over something and working on it.
Each return deepens the zoom:

| Visits to an area | Zoom |
| --- | --- |
| 1 | 1.35x |
| 2 | 1.53x |
| 3 | 1.71x |
| 4+ | up to a 1.95x ceiling |

Areas are counted separately, so working in one corner does not deepen a zoom
somewhere you only glanced.

### Following, past a deadzone

A held zoom drifts to keep you in frame, but only once the pointer has genuinely
travelled about a ninth of the frame. Below that nothing moves at all: reading a
line or nudging a slider should not move the camera.

The camera is a spring aimed a deadzone short of the pointer. Three behaviours
fall out of that one sentence: inside the deadzone nothing moves; crossing it by
a pixel asks for a pixel of travel rather than a jump; and the camera settles
behind the pointer instead of on top of it — sitting on the pointer is chasing,
and chasing reads as jitter. Being a spring, the motion is smooth in speed as
well as position: it builds, carries, and settles, rather than stepping and
stopping.

Following does nothing on a *pause* segment, by construction: a pause is a
stationary pointer. It earns its keep where you clicked something and then moved
on.

### The move itself

Zooms arrive with a slight overshoot and settle — a camera being aimed rather
than a viewport being slid. The overshoot is on the way **in** only. Every other
part of a move ends on a hard limit: pulling out ends at full frame, and a pan
is clamped to exactly what the current zoom can cover. Overshooting either would
show the background behind your recording for a few frames.

The camera also has a speed limit, quoted in frame-widths per second. A push to
a far corner takes longer than one to the middle, and a pan between two zooms
placed close together in time borrows a beat from the holds on either side
rather than sprinting the gap — losing a moment of looking at something already
on screen is cheap; the move is the part being watched.

A zoom that cannot fit its full travel inside the clip is dropped rather than
rushed. No zoom is better than one that snaps.

### When the recording is not the shape of the canvas

A capture whose aspect differs from the canvas is **fitted** — centred, aspect
kept, with transparent bars beside or above it — never stretched. The camera
knows where the picture ends: a zoom near the edge of the screen stops at the
edge of the *content*, so it cannot fill the frame with the letterbox bar. The
first recording in a project avoids the situation entirely by reshaping the
canvas to match the screen.

### Defaults

| | |
| --- | --- |
| Zoom | 1.35x, escalating to 1.95x on repeat visits |
| Move time | 0.9s each way |
| Minimum hold | 1.1s |
| Pause counts after | 1.0s |
| Group actions within | 2.5s |

A zoom costs move + hold + move, so at these values a clip shorter than about
three seconds will not get one at all.

---

## Limits worth knowing

- **Whole-screen shares only**, for cursor data. Window and tab shares record
  fine; they just cannot place the pointer.
- **System audio is Chrome-only**, and only with a tab or window share.
- **Region recording needs Chrome or Edge** (Insertable Streams).
- **The preview approximates; the export is authoritative.** Positions and
  timing agree by construction — they are asserted against the same numbers on
  both sides — but colour and texture can differ slightly.

## When something looks wrong

**No zooms appeared.** Check `cursord` is running (`curl 127.0.0.1:8791/health`)
and that you shared a whole screen. A clip under ~3s cannot fit a zoom.

**The zooms are in the wrong places.** They are ordinary keyframes: drag the
diamonds, or clear them in Auto Zoom and re-run with different settings.

**Too much movement.** Lower **Zoom**, raise **Minimum hold**, or turn off
**Zoom on pauses** to leave only clicks.

**A yellow disc follows the cursor.** That is the highlight, in Cursor Effects.
Untick it.
