# Crop, fit and style presets — three faults and the fix

Written 2026-08-21 from three reports, each traced to code before planning.

---

## Fault 1 — The clip toolbar covers the bottom of the picture

**Report:** "the crop window which opens when you select crop or blur covers the
video so there's no way you can drag the lower half."

**Cause.** `PreviewStage.tsx` renders the tool bar as a child of the stage area
with `absolute bottom-1 … z-20`. Its own comment says it is "below the picture
rather than on it" — and that was the intent, but absolute positioning inside
the stage area puts it *over* the frame's lower edge whenever the frame uses the
available height, which it always does. `CropToolbar` is also `flex-wrap` with
~13 items (label, size, 4 shapes, 4 fits, reset, done), so on a narrow stage it
wraps to two or three rows and grows **upward into the picture**. At `z-20` it
sits above `CropOverlay`'s `z-10` and swallows pointer events, so the bottom
edge grip is both hidden and unclickable.

**Fix.** Put it in the layout flow: move the block out of the stage area and
make it a sibling row in the outer flex column, above the transport. The stage
area is `flex-1`, so it shrinks and the existing `ResizeObserver` refits the
frame automatically. Nothing overlaps the picture, at any size, at any wrap
count.

---

## Fault 2 — Bars down the sides, and no way to remove them without cropping

**Report:** "if a video fills the canvas top and bottom but there's black on both
sides, how do I fix that? … the video frame I gave is complete in itself, let's
just have that video and no space, black or any colour, in any direction."

**Cause.** Two separate things, both real.

1. The canvas aspect menu offers **exactly three shapes** — `ASPECT_CANVAS` in
   `bridge.ts` is `9:16`, `1:1`, `16:9`. A 3:2 laptop capture, a 16:10 window, a
   4:3 screen or any imported clip that is none of those **cannot be matched**.
   `aspectOf` then snaps the canvas to the nearest of the three, so the TopBar
   chip mislabels it as well.
2. When a clip is barred, `CropSection` offers one button — **"Fill the frame —
   no bars"** — and Fill *crops*. For someone whose picture is already complete,
   every available answer is wrong: Fit bars it, Fill crops it, Stretch distorts
   it. The missing answer is "make the canvas this clip's shape", which costs
   nothing and loses nothing.

The `barred` detection itself is fine and symmetric — it triggers on pillarbox
as well as letterbox. The problem is the menu of answers, not the diagnosis.

**Fix.**

- New `matchCanvas.ts`: canvas dimensions from a clip's *cropped* source size,
  even-rounded (4:2:0), clamped to a sane maximum.
- Offer it wherever the problem is visible: in `CropSection` beside Fill, in the
  on-canvas `CropToolbar`, and in the TopBar aspect menu as "Match to selected
  clip".
- Present the two answers side by side and label the cost of each — **"Match
  canvas · nothing cropped"** and **"Fill · crops the edges"**. Today Fill is
  the only offer, so it reads as the only answer and silently crops.
- Add the missing shapes (4:3, 3:2, 16:10, 21:9) and a **Custom W×H** entry;
  show the true ratio in the chip rather than the nearest of three.
- Reuse `planReframe` so other clips adapt, inside one `mutate` — one undo, as
  the aspect switch already does. Clear `fit` on the matched clip: once it
  matches exactly, "fill" is a lie about what is happening.

---

## Fault 3 — Style presets: no control over the space they take

**Report:** "the style presets are bad, I cannot control their section and the
amount of space that they take."

**Cause.** Three things, and the third is a genuine bug.

1. **The panel cannot be put away.** `Section` keeps its open state in local
   `useState`, so collapsing anything resets the moment the inspector re-mounts
   — selecting another clip, switching panels. `StylePresetsSection` is
   `defaultOpen` (hardcoded true) with five two-column cards carrying a swatch,
   a name *and* a description, so it permanently occupies a large block of the
   inspector and will not stay shut.

2. **The space a preset adds is invisible and remote.** Each preset writes a
   backdrop `inset` — 0.03 to 0.10 depending on the preset — and that is what
   pushes the picture in from the edges. Nothing on the card says so, and the
   control that changes it lives in a *different* section (Backdrop → Padding).
   There is also no preset that removes a backdrop, so "no space at all" is not
   reachable from this panel at all.

3. **Padding cannot be set to zero.** `backdropInset` reads
   `b.inset || BACKDROP_DEFAULTS.inset` in TypeScript and `if f == 0 { f =
   backdropDefInset }` in Go — so **0 means "unset" and becomes 6%**. `radius: 0`
   likewise becomes 14px and `shadow: 0` becomes 0.55. The slider's `min={2}`
   compounds it. Square corners, no shadow and no padding are all unreachable.

   Both languages already handle a **negative** value correctly —
   `clampF(-1, 0, max)` is 0 — and `schema.go` documents exactly that for
   Shadow ("set a negative value to mean really none"). The contract exists and
   is golden-tested; only the UI never uses it.

**Fix.**

- `Section` persists open/closed per label in `localStorage`. Fixes every panel
  in the inspector, not just this one.
- Style presets collapsed by default, and cards compacted to one line each with
  the description moved to a tooltip.
- Each card shows the padding it will apply, so the space is not a surprise.
- A **"No frame"** preset that clears the backdrop outright — the direct answer
  to "no space in any direction".
- Padding / Corners / Shadow sliders **inline in the presets panel** whenever the
  clip has a backdrop, so tuning the space is where the space was chosen.
- All three sliders reach a true zero, writing the documented negative sentinel
  and displaying it as `0`. No schema change, no render change, no golden-test
  change — the contract was already there.

---

## Order

1. Fault 1 — smallest, and the other two are hard to even evaluate while the
   toolbar covers the picture.
2. Fault 3's zero-padding bug — one function, unblocks judging any framing.
3. Fault 2 — match canvas, then the wider shape menu.
4. Fault 3's remaining UI work.

Each step keeps `npm test` and `go test ./...` green, and Fault 2 adds tests for
`matchCanvas` beside the existing `crop.test.ts` / `reframe.test.ts`.

---

## Found while fixing Fault 3 — a latent origin bug the zero exposed

`backdropLayout` computed the picture's **position** with `even()`, the helper
that floors at 2 because a *size* of zero is meaningless. `schema.Pixels` already
draws the distinction and says why — "a size floors at 2; an origin does not,
because zero is where an untrimmed edge legitimately starts" — but the layout
helpers never had the second function.

Invisible for as long as padding had a 6% floor, since the offsets were large.
The moment padding could actually be none, a picture exactly filling the canvas
got an origin of `even(0)` = **2**: shifted 2px right and down, 2px of wallpaper
showing along the left and top edges, and 2px overflowing the right and bottom.
Measured in an export before the fix — left and top edges purple, right and
bottom edges picture, which is that offset exactly.

Fixed by adding `evenOrigin` to both languages and using it for every position:
`backdropLayout`, `bubbleLayout` and `deviceLayout` all had it. Bubble and device
origins are never near zero in practice, so nothing there changed — the full Go
suite passed with no golden shifted, which is the evidence that the bug was only
ever reachable through the new zero.

**Verified in the export, not just the preview:** with padding none, square
corners and no shadow, **0 of 4616 border pixels** carry the wallpaper colour.
With `radius 16` restored, 48 do — the rounded corners, correctly.

## Verification performed

| Fault | How it was checked |
|---|---|
| 1 · toolbar covering the picture | Crop/Blur bar renders below the stage in the running app; the stage shrinks to make room at every size |
| 2 · bars with no non-destructive fix | 1512×796 clip on a 1920×1080 canvas; "Match canvas to this clip" → chip reads `1.90:1 · 1512×796`, warning and buttons disappear, `fit` cleared, one undo. Export is 1512×796 at **PSNR 43.9 dB** against the source with both edge columns reading mean 238 — picture, not bars |
| 3 · presets and their space | Panel is one line per preset with the padding stated on each (`pad none / 8% / 6% / 10% / 4% / 3%`), collapsed by default and remembered. "Space it takes" sliders sit in the same panel; padding dragged to `none` clears the frame in preview **and** export |

Suites green throughout: 530 frontend tests, `go vet` clean, full `go test ./...`.
