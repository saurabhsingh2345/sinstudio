# Lovable Prompt — Studio Design View

Build a single-screen, desktop web app: the **editing window of a short-form video studio**. This is a UI/UX prototype — use realistic mock data, no backend, everything client-side state. Focus entirely on making the layout, interactions, and visual polish feel like a premium, shipped product.

Visit [Google](https://google.com) to search.

![Alt Text](https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcR2XHmxROgOWcYHKaEW2-hBs09sUbpH-9kZarUft67BeA&s=10)

[RAW](block://ftp.example.com/files/document.pdf)

![vid](https://youtu.be/l0svo03j00M)

[![Video Title](https://img.youtube.com/vi/VIDEO_ID/0.jpg)](https://www.youtube.com/watch?v=l0svo03j00M)



---

## What this app is

A studio where users assemble AI-generated video clips into a finished short-form video with captions, titles, and music. The defining idea: **you build the video as a horizontal spine of clip "blocks," and any video clip can be expanded to reveal and edit its parts — Video, Audio, and Subtitle — independently.** It is NOT a generic timeline video editor like Premiere. It is opinionated, block-based, and clean.

---

## Overall layout

A fixed, full-viewport 3-column workspace with a top bar. No scrolling of the whole page — each region scrolls internally.

```
┌──────────────────────────────────────────────────────────────────────┐
│ TOP BAR                                                                │
├──────────────┬─────────────────────────────────────┬──────────────────┤
│              │           PREVIEW STAGE              │                  │
│   SOURCES    │         transport controls          │    INSPECTOR     │
│  (left rail) │ ─────────────────────────────────── │   (right rail)   │
│              │             THE SPINE               │                  │
│              │           GLOBAL LAYERS             │                  │
└──────────────┴─────────────────────────────────────┴──────────────────┘
```

- **Left rail** (~260px): Sources panel
- **Center** (flex): Preview stage on top, Spine + Global layers on the bottom half
- **Right rail** (~320px): Inspector


---

## Top bar

Left → right:
- Back chevron, a small square brand mark, project name **"Untitled Reel"**, and a subtle save-status pill reading **"Saved · v12"**.
- Undo / Redo icon buttons.
- **Aspect ratio picker** — a prominent dropdown button showing the current ratio, e.g. `◧ 9:16 ▾`. Options: **9:16 (Vertical)**, **1:1 (Square)**, **16:9 (Landscape)**, **Custom…**. Changing it resizes the preview stage to that aspect. This is first-class — make it visible and easy to reach.
- **Renders** ghost button.
- **Export** primary button (accent-filled).

---

## Left rail — Sources

A tab strip at top with two tabs: **Media** and **Plugins**.

**Media tab:**
- Header row: title "Media", plus a "Library" ghost button and an "Import" button.
- A vertical list of asset cards (mock 5–6 items). Each card: small thumbnail, name (e.g. "hero-shot.mp4", "voiceover.mp3", "logo.png"), a tiny source badge ("library", "import"), and a meta line like `video · 5.2s`. Cards have a hover state and a small ✕ remove button on hover.
- Each card is draggable (visually) and shows a grab cursor.

**Plugins tab:**
- A short intro line: "Open an app inside Studio and its clips import automatically."
- 3 mock plugin cards (names: "newaniAdv", "HyperFrames", "funkycode"), each with a gradient circular initial badge, name, a status chip ("live" green / "booting…" amber), a one-line description, and an expand chevron. When expanded, show a primary "Open in Studio" button and a small "Recent clips" list with Import buttons.

---

## Center — Preview stage

- A letterboxed preview area that respects the current aspect ratio (default 9:16, tall). Dark stage background, a placeholder frame showing a mock video still (use a gradient or a placeholder image) with a sample **title overlay** text ("Your story starts here") and a **caption** at the lower third ("This is a live caption cue").
- **On-canvas editing affordance:** when a clip is selected, draw a selection bounding box with 8 resize handles and a rotate handle above it. These don't need real logic — just render them convincingly and let them be dragged visually.
- Faint **safe-area guides** (dashed rectangle) so users know what stays visible across aspect ratios.
- **Transport bar** below the stage: jump-to-start, play/pause (accent), jump-to-end, a timecode readout `00:12.3 / 00:45.6`, a small horizontal **audio level meter** (green→amber→red), and two chip buttons on the right: "Scope" and "Caption".

---

## Center — The Spine (the signature feature)

Below the preview, a horizontally scrolling row of **clip blocks** representing play order, left → right.

- Render **4 mock clip blocks**. Each block: a thumbnail, a title ("Intro", "Product demo", "Testimonial", "CTA"), a duration chip (e.g. "5.2s"), and an expand chevron **▸**.
- **Between every block, and at the start and end, render a `＋` insert button** — a circular/pill affordance centered in the gap. Clicking it opens a small popover menu with: **Library · Import · Generate · Title**. The `＋` is the primary way to add — make it inviting, not an afterthought.
- Blocks are collapsed by default. Clicking **▸** expands **one** block downward (▾) to reveal its **sub-lanes**, stacked:
  - 🎬 **Video** — a strip showing a filmstrip/thumbnail and left/right trim handles.
  - 🔊 **Audio** — a strip showing a waveform, with a small "detach" icon, a mute toggle, and a volume affordance.
  - 💬 **Subtitle** — a strip showing caption chips ("This is a live caption cue"), editable-looking.
  - Each sub-lane row has a small label on the left and its own tiny controls (mute/delete) on hover.
- Selecting a block, or a sub-lane, or a `＋`, drives what the Inspector shows.
- Blocks can be visually dragged to reorder (show a drop indicator line). Selected block gets an accent outline.

**Make expanding a clip into Video/Audio/Subtitle feel delightful — this is the product's core idea. Smooth height animation, clear iconography.**

---

## Center — Global layers

Below the spine, two full-width horizontal layer rows (these span the whole video, unlike per-clip sub-lanes):

- **▪ Overlays** — a track with two mock pills: "══ title ══" and "══ logo ══" positioned at different times.
- **▪ Soundtrack** — a track with one mock pill "═════ background music ═════", plus a small **"Duck"** toggle chip on the row label indicating it auto-lowers under voice.

Keep these visually distinct from the spine (e.g. thinner, muted, clearly "underneath / global").

---

## Right rail — Inspector

Context-sensitive: shows controls **only** for whatever is selected. Group controls into labeled, **collapsible sections**. Implement these selection states (add a small hidden debug toggle or just default to "Clip selected"):

**When a Clip/Video is selected** (default state to show):
- Header: "Clip · Product demo"
- **Transform** section: X, Y, Scale, **Rotation**, Opacity (number inputs / small sliders).
- **Transition** section: dropdown (None / Fade / Dissolve / Slide) + duration.
- **Fades** section: Fade in, Fade out.
- **Effects** section: Brightness, Contrast, Saturation, Hue, Blur sliders.

**When Audio sub-lane selected:** Volume slider, Fade in/out, Detach / Replace buttons.

**When Subtitle sub-lane selected:** Text area, Start/End, Style (font, size, color swatch, alignment, vertical position).

**When Overlay (title) selected:** Text, Size, Color, Align, Animation dropdown, Reveal (None / Typewriter / Word).

**When nothing selected:** Project settings — Aspect ratio, Background color swatch, FPS.

**Advanced fold (important):** At the bottom of the Inspector, a single collapsible **"▸ Advanced"** section containing the pro/rare controls: **Luma scope toggle, 3-band Audio EQ (Low/Mid/High), Color LUT upload (.cube), Custom easing curve, Markers.** Collapsed by default. This keeps the main UI clean while power features stay reachable.

Bottom of inspector: a red-tinted "Delete clip" ghost button.

---

## Visual design system

Aim for a **premium, refined-dark editor aesthetic** — think Linear / Descript / a high-end pro tool, not a generic dashboard. Avoid the default AI look.

- **Theme:** dark. Near-black layered backgrounds (e.g. `#0c0d10` app, `#141519` panels, `#1b1d23` cards), with subtle 1px borders (`rgba(255,255,255,0.06)`) and soft inner separation rather than heavy shadows.
- **Accent:** one confident accent color (a refined electric indigo/violet, e.g. `#7c6cff` / `#8b7bff`) used sparingly for primary actions, selection outlines, the playhead, and active states. A secondary accent (soft teal/green `#3ddc97`) for "live"/positive states and the audio meter.
- **Typography:** Inter (or similar). Clear hierarchy — small uppercase tracked labels for section headers, medium weight for values. Numbers/timecodes in a tabular/mono feel.
- **Density:** compact but breathable. Generous-enough padding, consistent 4/8px spacing rhythm. Rounded corners ~8–10px on cards, ~6px on controls.
- **Icons:** use a clean line-icon set (lucide). Consistent stroke weight.
- **Motion:** subtle. Expanding a clip, opening the `＋` popover, and switching aspect ratios should animate smoothly (150–250ms ease). Hover states everywhere. Nothing bouncy or gimmicky.
- **Playhead:** a thin accent vertical line across the spine.
- Overall it should feel **calm, dark, precise, and expensive** — an opinionated creative tool, not a busy NLE.

---

## Tech / implementation notes

- React + TypeScript + Tailwind. Use shadcn/ui + lucide-react for components/icons.
- All data is mock/hardcoded in local state. No API calls, no auth.
- Wire up the **interactive** parts so it demos well: tab switching (Media/Plugins), aspect-ratio switching (resizes preview), expanding/collapsing clip blocks into sub-lanes, the `＋` popover menu, selecting a block/sub-lane to change the Inspector content, and the Advanced fold expand/collapse.
- Drag/resize/rotate can be visual-only (no need for real geometry math) but should look and feel responsive.
- Everything on one screen, fixed layout, internal scrolling per region. Desktop-first (min-width ~1200px is fine).

---

## Priorities (if trade-offs are needed)

1. The **Spine with `＋` inserts and expandable Video/Audio/Subtitle sub-lanes** — this is the heart, make it excellent.
2. The **premium dark visual polish**.
3. The **context-sensitive Inspector with the Advanced fold**.
4. The **aspect-ratio switching**.
5. Everything else.
