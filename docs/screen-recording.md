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
| **Whole screen** | One display, all of it. The most certain pointer tracking, because a display cannot be dragged somewhere else. |
| **Window** | One app's window. Studio follows it: move or resize it mid-take and the effects stay on it. |
| **Browser tab** | One tab's page. Studio's own tab is excluded from the picker, so you cannot record the editor by accident. |
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
and every later decode all shrink with it. That is the one thing that cannot be
done afterwards, and the only reason to choose a region up front: if you just
want the menu bar gone from the finished video, **Crop & fit** on the clip does
that later, reversibly, and with the pixels still there if you change your mind.

Needs Insertable Streams (Chrome/Edge). There is deliberately **no fallback**:
the obvious alternative, drawing frames to a canvas, is driven by
`requestAnimationFrame`, which stops in a backgrounded tab — and a screen
recorder's tab is backgrounded by definition, because you are looking at the
thing being recorded. That version records a few seconds and then a
freeze-frame. A feature that fails exactly when it is used is worse than one
that is honestly absent.

---

## Cropping a clip afterwards

Select a clip and press **C**, or use **Crop & fit** in the inspector. The whole
picture is shown with the part you are cutting dimmed rather than hidden —
you are choosing what to remove, so it has to stay visible while you choose.
Drag any edge or corner; drag inside to slide the window; Escape or **Done**
ends it.

Then the half people are surprised by. Trimming the top off a 16:9 recording
leaves a picture that is *wider* than 16:9, so it letterboxes — the clip that
was flush with the frame a moment ago now sits in bars, which reads as the crop
having broken something. It hasn't; it changed the shape. **Fill** covers the
frame with what is left, and the panel offers it as one button ("Fill the frame
— no bars") exactly when the clip is actually barred.

| Fit | What it does |
| --- | --- |
| **Auto** | Letterbox. Nothing is cropped that nobody asked to crop. |
| **Fit** | Show all of it, transparent bars where the shapes differ. |
| **Fill** | Cover the frame; anything past the edge is not shown. Which part survives is yours to drag — see below. |
| **Stretch** | Distort to fill. Rarely right, occasionally exactly right. |

When a clip fills, exactly one axis overflows and the rest is thrown away.
Which part gets thrown away is a choice, and **What stays in frame** in the
Crop & fit panel is where you make it: drag along the track to slide the window
over the picture. Centred is the default, and it is only the right answer when
the subject happens to be in the middle. The control appears only when the clip
really does overflow — a picture already the canvas's shape has nothing to
choose between.

**Auto used to fill** whenever the camera was working the clip — and since every
screen recording carries cursor effects, that quietly cropped a quarter off any
recording whose shape did not match the canvas. It was there so that a push-in on
a letterboxed picture could never slide the transparent bar into frame; that is
handled properly now by clamping the camera to the picture rather than to the
frame. Projects made before the change keep the framing they had: the fit each
clip was effectively getting is written onto it once, so nothing moves underfoot.

One consequence worth knowing. On a letterboxed clip the camera can only follow
your pointer once the zoom is deep enough for the picture to cover the frame —
below that, any pan would just show more bar on one side, so the push-in stays
centred. The way to get a following camera on a mismatched recording is to stop
it being mismatched: match the canvas to the recording.

A crop changes what the clip's picture *is*, so everything downstream is told
the new shape: the letterbox, the pan clamp that keeps a zoom inside the
content, the backdrop card's geometry, and the pointer track's coordinate space.
That last one matters — cutting the top off without moving the recorded pointer
would leave every highlight and click ring exactly as far down as the crop was
deep, which looks like the cursor effects being miscalibrated rather than like a
crop that forgot something.

**Crop to canvas shape** is the shortcut for "make this match the others": it
takes equal bites out of the long axis until the picture is the canvas's shape,
so it fills with nothing cut off-centre.

Redactions are fractions of the **uncropped** source and are applied before the
crop, so trimming an edge can never slide a blur off the thing it was hiding.

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

### How a window or a tab gets mapped

`cursord` reports the pointer in screen coordinates. Those land on the video
only if something knows where the video *is* on the screen — and the browser
will not say. A share arrives as a size and one of three words: `monitor`,
`window`, `browser`. Which monitor, which window, and where, are all withheld.

So the two halves are joined by **shape**. `cursord` enumerates every display
and window with its rectangle; Studio matches the granted share against them on
aspect ratio, which is the one property that survives the trip (a capture is in
pixels, the operating system reports points, and a large share may be
downscaled — a ratio is immune to all three). It then tells `cursord` which
surface to follow, and that rectangle is sampled for the rest of the take, so a
window you drag halfway through keeps its effects.

Everything then maps the same way — pointer minus the surface's origin, over the
surface's size — and a whole display is simply the case where that rectangle is
the display. Multi-monitor falls out of the same change: the old code scaled
against the *main* display's size, so recording a second monitor placed every
effect somewhere the pointer had never been.

Two honest limits remain:

- **Two windows the same shape** cannot be told apart by shape. Studio picks the
  likelier one and says so, with the alternatives one click away in the record
  panel. It does not pretend to be certain.
- **A tab's rectangle is inferred**, not observed: the operating system can see
  the browser window, and the recording is that window's page. Studio finds the
  window by width and anchors the viewport to its bottom edge, which is where
  web contents sit. Developer tools docked along the *bottom* break that
  assumption — record the window instead if the effects land low.

When nothing matches, Studio attaches no pointer data and says so **while the
share is still live**, rather than after the take.

Window geometry is macOS-only for now. Elsewhere `cursord` reports
`surfaces: false` and Studio keeps the old rule: whole-screen shares get cursor
effects, window and tab shares record fine without them.

### Cursor shapes

`cursord` also reports *which* system cursor is showing — arrow, I-beam,
pointing hand, crosshair, resize — and Studio draws that shape rather than an
arrow throughout. A tutorial of a web app is mostly links and text fields, and an
arrow sitting over both says something false about the interface.

The shapes are drawn, not bundled as art: a PNG is fixed-resolution and its
hotspot is not a number the code knows. Each one carries its own hotspot, so the
cursor sits on the pixel it is pointing at whatever shape it is.

A shape held for less than about an eighth of a second never appears, and two
stretches of the same shape close together become one. Dragging across a row of
links crosses in and out of the hand cursor several times a second, and following
that honestly is a strobe.

macOS only for now, like window geometry. Elsewhere `cursord` reports
`kinds: false` and every moment is drawn as an arrow — the readiness panel says
so rather than leaving you to notice. **Rebuild `cursord` to get this**; an
installed binary from before it existed reports nothing and behaves exactly as
it always did.

Choosing **Dot** or **Ring** as the pointer style opts out: those are a
deliberate stylisation, and turning one into an I-beam over every text field
would be ignoring what was asked for.

Note that **Size** now means the cursor's height**.** It previously meant a unit
the arrow was 1.12 of, so an existing project's cursor draws about a tenth
smaller than before at the same setting.

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

## Switching to vertical

The aspect menu in the top bar reframes the project, it does not merely resize
the frame. Changing the canvas alone drops a 16:9 recording into a 1080×1920
letterbox with two thirds of the picture missing — "vertical" is a decision
about what stays in frame, not a canvas size.

So anything that would letterbox is filled instead, and every clip with a
pointer track has its camera **recomputed** for the new shape: the same pass
that ran when the recording landed, asked again with a different answer
available. A 9:16 frame has far less width to spare, so what it finds is a
genuinely different camera rather than the landscape one stretched.

The whole switch is one undo, and the toast says how many clips it touched.
Webcam bubbles and device frames are left alone — both already fit the picture
into something of their own, and filling would crop the thing they are built
around.

---

## What happens when a recording lands

Automatically, as the clip hits the timeline:

1. **The canvas takes the shape of your screen.** Only for the first clip in a
   project — after that the canvas is a decision you have made. A 3:2 laptop
   recorded into a 16:9 project would otherwise sit in black bars.
2. **Zooms are found and written**, from where you clicked and where you paused.
3. **Click rings** are switched on.
4. **The cursor is smeared along its travel on fast moves.** The clip's own
   Motion blur cannot do this: the cursor is composited after it, so the picture
   smears while the pointer stays razor-sharp, which is backwards.
5. **The cursor presses in at each click.** The rings say where a click landed;
   the cursor giving is what reads as a press having happened.
6. **The cursor is set to fade out after 3s of stillness**, and to come straight
   back the moment it moves. A tutorial parks its pointer for long stretches
   while the narrator talks, and a cursor sitting in shot doing nothing keeps
   the viewer waiting for it. Only applies when Studio draws the cursor — a
   burned-in one cannot fade. Set **Hide when idle** to `never` to turn it off.

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

- **Window geometry is macOS-only.** Elsewhere, cursor data still needs a
  whole-screen share; window and tab shares record fine without the effects.
- **A tab's position is estimated** from its browser window — see above.
- **System audio is Chrome-only**, and only with a tab or window share.
- **Region recording needs Chrome or Edge** (Insertable Streams).
- **The preview approximates; the export is authoritative.** Positions and
  timing agree by construction — they are asserted against the same numbers on
  both sides — but colour and texture can differ slightly.

## When something looks wrong

**No zooms appeared.** Check `cursord` is running and new enough to report
window geometry: `curl 127.0.0.1:8791/health` should say `"surfaces": true`. If
it says `false`, rebuild it (`cd tools/cursord && go build`). A clip under ~3s
cannot fit a zoom whatever the pointer data says.

**The effects are on the wrong window.** Two windows the same shape are
indistinguishable by shape. The record panel offers the alternatives while the
share is live; pick the right one there.

**A tab's effects sit too low or too high.** Its rectangle is inferred from the
browser window, and something is between the toolbar and the page — developer
tools docked at the bottom, most likely. Record the window instead.

**The zooms are in the wrong places.** They are ordinary keyframes: drag the
diamonds, or clear them in Auto Zoom and re-run with different settings.

**Too much movement.** Lower **Zoom**, raise **Minimum hold**, or turn off
**Zoom on pauses** to leave only clicks.

**A yellow disc follows the cursor.** That is the highlight, in Cursor Effects.
Untick it.
