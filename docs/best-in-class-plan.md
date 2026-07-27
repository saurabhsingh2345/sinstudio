# Studio → one of the best browser video editors

A plan. Written 2026-07-27, from a survey of the code + `docs/roadmap-status.md`.
Not verified by running the app.

**Audience — decided 2026-07-27, this is the axis everything else hangs off:**
teams making tutorials, internal docs, and product videos. Camtasia + Loom +
Frame.io, not CapCut. The recorder is the moat; collaboration and distribution
are the sale; the NLE only has to be good enough that nobody leaves. Ordering in
§3 follows from this — see §7 for what the other answer would have changed.

---

## 1. Where we actually stand

Scored against the browser field (Descript, CapCut Web, Clipchamp, Veed, Kapwing,
Canva, Runway) and the desktop bar (Camtasia, Premiere, Resolve).

| Area | Standing | Notes |
|---|---|---|
| Screen recording | **Top of field** | Region capture, cursord sidecar, own-cursor drawing, readiness panel, teleprompter, countdown. Nothing in the browser is close. |
| Tutorial polish | **Top of field** | SmartFocus auto-zoom w/ spring camera, click FX, keystroke badges, device frames, backdrops, redactions, chroma. |
| Timeline mechanics | **Competitive** | Multitrack, ripple, keyframes, transitions, markers, retime, marquee, lock/height, z-order. |
| Render backend | **Ahead** | 1.5k-line ffmpeg compiler, golden-tested geometry in both languages, real dB/edge-energy assertions. |
| **Playback engine** | **Behind — structural** | DOM `<video>` + CSS. Not frame-accurate, degrades with layers, effects approximated. |
| **Collaboration** | **Absent** | One shared password (`auth.go`). No accounts, sharing, comments, presence, version history. |
| **AI editing** | **Partial** | Transcript panel, silence cut, chapters, filler words, B-roll gaps. No word-level doc-editing, dubbing, diarization, auto-shorts. |
| Media management | **Behind** | No proxies, no folders/tags/search, no stock, no brand kit, no fonts. |
| Audio finishing | **Behind** | Per-clip EQ/denoise/ducking, but no mixer, meters, LUFS, FX rack. |
| Color | **Behind** | LUT + luma histogram only. No wheels/curves/HSL, no vectorscope/parade. |
| Editing *feel* | **Behind** | 7 keyboard shortcuts total. No JKL, no I/O, no trim tools, no command palette, no keymap. |

**Verdict:** best-in-class recorder, respectable NLE, non-competitive platform.
The recorder is a moat worth defending — the plan below does not dilute it.

---

## 2. The keystone bet: one render graph, two runtimes

### The problem

`preview-engine.ts` computes compositing in CSS terms; `render/render.go` computes
it in ffmpeg terms. They're kept honest by golden tests (`arrowHead`, `keysLayout`,
`deviceLayout`, `backdropLayout`). That discipline works, but it means:

- **Every effect costs two implementations plus a golden pair.** Feature velocity
  is permanently halved.
- **Some effects cannot be previewed truthfully.** Mosaic has no CSS equivalent;
  LUTs aren't applied in preview; blur strength is converted by hand
  (`previewBlurPx`). The editor shows something that isn't the output.
- **No frame accuracy.** A `<video>` seeks to the nearest keyframe-decoded frame;
  scrubbing 4K is a slideshow; N simultaneous `<video>` elements collapse.
- **Every export is a server round-trip.** No instant export, no offline, and
  render cost scales linearly with users.

### The target

One declarative **RenderGraph IR** — a JSON description of layers, sources,
effects, and time — compiled *once* from `EditDoc` in TypeScript. Two executors:

1. **Browser executor** — WebCodecs `VideoDecoder` for frames, WebGL2 (WebGPU
   where available) compositor for every effect, WebAudio for the audio graph.
   Drives preview *and* fast local export via `VideoEncoder`.
2. **Server executor** — the existing Go ffmpeg compiler, retargeted to consume
   the IR instead of walking `EditDoc` directly. Final renders, long projects,
   anything the browser can't hold.

Preview/export parity stops being a discipline and becomes a property: same graph,
two backends, one frame-diff harness in CI.

`ChromaVideo.tsx` already proves the pattern — a `<video>` used as a GL texture,
driven by the existing preview engine, thresholds computed identically both sides.
Generalise that.

### Migrating without stopping the world

1. Define the IR and write the **parity harness first**: a fixture set of ~30
   projects, render frame N in both executors, assert per-effect ΔE budgets.
   No IR effect ships without a fixture.
2. Build the browser executor behind a flag; DOM preview stays the fallback.
3. Port effects in this order — *worst CSS lie first*: mosaic/blur → LUT →
   chroma (move the existing shader in) → transforms/opacity/blend → annotations
   (SDF shaders port almost directly from `annotation.go`) → device/backdrop/bubble.
4. Retarget `render.go` to the IR only after browser parity holds. Until then Go
   keeps its current path and the harness compares against it.
5. Delete the DOM preview when the flag has been default-on for a release.

**Cost: 6–10 weeks.** It is the most expensive item here and the only one that
raises the ceiling on everything else. Everything in §3 gets cheaper after it.

---

## 3. Phased plan

Letters are stable IDs, not the running order. **Execution order, given the
audience decision:**

| Wave | Phases | Why here |
|---|---|---|
| 1 (now → ~10 wks) | **A** editing feel, **C** collaboration, **I** docs & distribution | What a team buys. None of it needs the engine rewrite. |
| 2 (parallel, low headcount) | **B** playback engine — IR + parity harness + **proxies** | Long-lead. Proxies ship early on their own; the rest lands when it's ready. |
| 3 (~10–20 wks) | **E** AI editing, **D** media/templates/brand | Compounding value once teams have content in the system. |
| 4 | **F** audio, **G** color, **H** scale | Cheap after B. Not what wins this audience. |

DOM preview survives another quarter. That's the explicit trade: a
tutorial/product video is 1080p screen capture with few layers — the case DOM
preview handles least badly — so fidelity buys less here than a review link does.
Phase B is not cancelled, just de-risked into background work.

### Phase A — Editing feel (2–3 weeks, high ratio of impact to cost)

The cheapest credibility on the list. Today `StudioView.tsx` binds seven keys.

- **Keymap system**: a data-driven binding table, not `if (k === "s")`. Ship
  Premiere / Final Cut / CapCut / Resolve presets + user rebinding + a cheatsheet
  overlay (`?`).
- **Pro transport**: JKL shuttle (multi-tap = 2×/4×), `I`/`O` in-out points,
  `,`/`.` frame trim, `\` fit, Home/End, `+`/`-` zoom, `\`` solo.
- **Trim tools**: ripple, roll, slip, slide as real modes (`A`/`N`/`Y`/`U`), with
  the two-up trim preview. Roll and slip are the two most-missed.
- **Track targeting + three-point edit**: source/record targeting, `,`/`.`
  insert/overwrite from a source monitor.
- **Command palette** (`⌘K`) over every action, effect, asset, and marker.
- **Undo history panel** — named states, jump-to-state. The transient/commit
  machinery already supports it.
- **Version snapshots + crash recovery**: autosave already debounces 600 ms; add
  periodic named snapshots and a "restore unsaved work" path on reload.
- **Layout presets** — Record / Edit / Color / Audio workspaces; resizable,
  poppable panels; remembered per project.
- **First-run onboarding** — a 60-second guided first recording. The auto-framing
  lesson (nine commits lost to a feature hidden behind a collapsed accordion)
  generalises: discoverability *is* the feature.

### Phase B — Playback engine (6–10 weeks, wave 2 background work) — §2 above

De-risked, not dropped. Two things are pulled forward into wave 1 because they
pay off without the rest: the **proxy pipeline** and the **parity harness**. The
harness in particular should exist before more Go/TS effect pairs get written —
it is what stops the two-implementation tax from growing while B is pending.

Sub-deliverables worth tracking separately:

- **Proxy pipeline** (wave 1): generate 540p/720p proxies at ingest (background
  job in the existing lane-partitioned queue). Editor plays proxies; export uses
  source. This alone makes 4K editing feel professional and is worth doing even
  if the rest of B slips.
- **Frame cache + prefetch**: decode-ahead ring buffer keyed by (asset, frame).
- **Audio graph**: WebAudio mirror of the audio side — real meters, scrub audio,
  sample-accurate sync. Today the click sounds are already Web Audio; extend.
- **Local export**: `VideoEncoder` + fragmented-MP4 muxer for projects under a
  threshold. Instant export is a headline feature *and* cuts server cost.
- **Performance budgets as CI gates**: scrub latency < 1 frame at 1080p proxy;
  timeline interaction at 60 fps with 500 clips; 8 simultaneous video layers.

### Phase C — Collaboration (4–6 weeks, wave 1) — the reason to be in a browser

- **Real identity**: accounts, orgs, roles (owner/editor/reviewer/viewer),
  invites. Replaces the shared-password `Auth`. Prerequisite for everything else
  here.
- **Review links** — the highest-value single feature in this phase. A shareable
  URL, no login required, that plays the render and takes **frame-accurate
  comments** with drawing on the frame. Comments land on the timeline as markers
  the editor can resolve. This is what Frame.io monetises.
- **Presence + live co-editing**: per-clip operation log on top of the existing
  optimistic-concurrency store; last-write-wins per property, not per document.
  Cursors and selections broadcast over the existing SSE channel.
- **Version history**: named versions, diff two versions of a timeline, restore.
- **Project-level comments, @mentions, notifications.**
- **"Copy link at 1:23"** everywhere.

### Phase D — Media, templates, brand (3–5 weeks)

- **Asset library that scales**: folders, tags, full-text search, dedupe by
  content hash, usage ("where is this used?"), bulk ops.
- **Brand kit**: fonts (embed them — this also unblocks the ⌘/⇧ glyph problem
  documented in the keystroke-badge notes), colors, logos, intro/outro, lower
  thirds. One switch restyles a project.
- **Motion templates**: reuse the plugin `fields` contract — a template is a
  timeline fragment with exposed typed fields and a generic editor. No new
  concept, no new editor, and it inherits the "schema is a view" rule.
- **Transition pack**: wipe/push/slide/zoom/whip beyond the current dissolve.
- **Title & animation presets** with in/out choreography.
- **Shapes, masks, adjustment layers** — masks unlock tracked blur and vignettes.
- **Stock**: royalty-free music/SFX/B-roll via one provider integration.

### Phase E — AI-native editing (4–6 weeks) — where "best" is won in 2026

Half of this already exists in pieces; the win is making it the default path.

- **Text-based editing, properly**: word-level timings from whisper, edit the
  transcript and the timeline follows — delete a word, cut the video. This is
  Descript's entire moat and you're one word-timing pass away from it.
- **Word-by-word animated captions** (already scoped: per-word timing + ASS
  karaoke export). Table stakes for social.
- **Speaker diarization** → auto-cut multicam/multi-speaker to the active talker.
- **Translate + dub** — kokoro is already wired as a generator; add per-language
  caption tracks and a dubbed audio track.
- **Auto-shorts**: score the transcript for highlights, cut candidates, reframe
  9:16 reusing the SmartFocus focus data (`presetDims` already has shorts/square).
- **Filler/retake removal**: filler detection exists; add "keep the last take"
  by detecting repeated phrasing.
- **Edit-as-a-diff agent**: "tighten this to 90 seconds" produces a *proposed*
  edit the user accepts or rejects — one `updateClip`, one undo. Never silently
  mutates. The transient/commit machinery makes this cheap.

### Phase F — Audio finishing (2 weeks)

Mixer view with faders and per-track meters; LUFS normalisation (−14 for
YouTube, −16 for podcast); per-track FX rack (EQ/compressor/limiter/gate/reverb);
voice isolation; music beat detection + auto-cut-to-beat; auto-duck exists
(sidechain) — surface it in the mixer.

### Phase G — Color (2 weeks)

Lift/gamma/gain wheels, curves, HSL qualifier; vectorscope + RGB parade +
waveform (luma histogram exists); auto white balance; shot-match; adjustment
layers. Cheap once Phase B lands — these are shaders.

### Phase H — Scale and distribution (ongoing)

Finish the existing scaling roadmap (object storage → api/worker split →
capability queues); GPU render nodes (NVENC) with priority queues; export presets
+ direct publish to YouTube/Drive/Slack/Notion; embeddable player; telemetry and
error reporting; an export-time SLO. Also: fix the known Docker blocker — plugin
adapters use relative sibling paths and ship in no image.

### Phase I — Video documentation & distribution (4–6 weeks, wave 1)

**This phase exists only because of the audience decision.** For a team making
tutorials and product docs, the video is not the deliverable — the *explanation*
is, and it has to live where the docs live, stay current, and prove it was
watched. None of this matters to a general NLE, and most of it is cheap on top of
the transcript, chapters, and marker machinery that already exists.

- **Embeddable player** with chapters, a searchable transcript, speed control,
  and deep links (`?t=`). One `<script>` tag or an iframe; works in Notion,
  Confluence, Zendesk, Intercom, a docs site.
- **Watch analytics**: views, completion, drop-off curve per chapter. Drop-off
  against the timeline is the single most actionable thing you can hand an
  author — "everyone quits at 2:14" points straight at the step that's confusing.
- **Segment re-record** — the killer feature for docs that rot. Pick a range,
  re-record just that, and the new take drops in with the surrounding edit,
  zooms, and captions intact. Requires: range selection → record into a replace
  slot → re-run auto-framing on the new clip only → re-transcribe that span.
  Everything named there already exists in some form.
- **Auto step-by-step doc export**: a recording already has a pointer track,
  click times, keystroke badges, and a transcript. That is enough to emit a
  numbered written guide with a screenshot per click — Scribe's whole product,
  falling out of data you capture anyway. Export to Markdown / HTML / PDF.
- **Interactivity** (the unbuilt Camtasia half): clickable hotspots, quizzes,
  branching, and SCORM/xAPI export for training teams. Highest-effort item here;
  gate it on whether training is a real segment for you.
- **Localization pipeline**: per-language caption tracks + dubbed audio (Phase E)
  surfaced as language variants of one video, one link, viewer picks.
- **Team library**: shared brand kit, intro/outro, and template videos with
  enforced styling, so ten authors produce one house style. Pairs with Phase D.
- **Publish targets**: YouTube/Drive/Slack/Notion, plus a permalink whose URL
  survives a re-render — docs links must not break when the video is updated.

---

## 4. Cross-cutting bars (not a phase — a standard)

- **Parity is a CI gate.** Fixture projects, frame diff, per-effect ΔE budget.
- **Never lose an edit.** Snapshot + recovery + conflict resolution, tested by
  killing the tab mid-edit.
- **Keyboard-complete and accessible.** Every action reachable without a mouse;
  ARIA on the timeline; contrast checked in both themes.
- **Performance budgets in CI**, per Phase B.
- **The default path does the thing.** Re-read the auto-framing lesson before
  every feature: breadth is worthless behind a collapsed accordion.

---

## 5. The first 90 days

Wave 1, in dependency order. Accounts gate half of it, so they go first even
though they demo poorly.

**Weeks 1–3 — foundation and feel**
1. **Accounts, orgs, roles** (C). Replaces the shared-password `Auth`. Blocks
   review links, team library, and analytics — start day one.
2. **Keymap system + pro transport + trim tools + ⌘K palette** (A). Parallel
   track, no shared files, demo-visible immediately.
3. **Proxy pipeline** (B, pulled forward). Background job at ingest.

**Weeks 4–7 — the sale**
4. **Review links with frame-accurate comments** (C). No login for reviewers,
   comments land as resolvable timeline markers. The clearest thing to sell and
   the thing that makes the browser the right place to be.
5. **Embeddable player + deep links + searchable transcript** (I).
6. **Undo history, version snapshots, crash recovery** (A). "Never lose an edit"
   is a team-purchase requirement, not polish.

**Weeks 8–12 — the wedge nobody else has**
7. **Segment re-record** (I). The reason a docs team picks this over Loom.
8. **Watch analytics with a drop-off curve on the timeline** (I).
9. **Word-level transcript editing** (E.1), on the existing transcript panel.
10. **Auto step-by-step doc export** (I) — Markdown/HTML from the pointer track,
    clicks, and transcript you already capture.

Running underneath the whole quarter: **Phase B's IR + parity harness**, one
person, no deadline. Presence/live co-editing is deliberately *not* in the 90
days — review links deliver most of the collaboration value at a fraction of the
risk, and CRDT work should follow real usage.

## 6. Deliberately not doing

- Native desktop shell (already deferred; browser recorder is the moat).
- Multicam sync, 3D, node compositing, VR — different product.
- Chasing Premiere's whole surface. The bet is: **best recorder + best review and
  distribution + best AI editing**, with an NLE good enough that nobody has to
  leave. Being the 20th passable NLE is not a position.
- Live co-editing / CRDT presence in the first 90 days — review links carry most
  of the value at a fraction of the risk. Revisit after real usage.
- Stock media, transitions packs, and colour wheels early. Creator features; this
  audience asks for consistency and sharing first.

## 7. The audience decision, and what it bought

**Decided 2026-07-27: teams making tutorials, docs, and product videos.**
Camtasia + Loom + Frame.io. The rejected alternative was a general browser NLE
(CapCut/Descript territory).

What the decision changed:

- **C before B.** Collaboration is the sale; DOM preview is tolerable for 1080p
  screen capture with few layers. Under the other answer, B was first and
  non-negotiable — a general NLE lives or dies on scrub feel and fidelity.
- **Phase I exists at all.** Embeddable player, watch analytics, segment
  re-record, doc export, SCORM. None of it belongs in a general NLE.
- **D and G dropped down.** Stock libraries, transitions packs, and colour wheels
  are creator features. A docs team needs a brand kit and consistency, which is
  the part of D that stays near the front.
- **The recorder stays the moat and gets defended**, not diluted by chasing NLE
  surface area.

**Revisit this if** a general-purpose usage pattern shows up in the data — heavy
imported (non-recorded) footage, many-layer projects, or people asking for
transitions and colour before they ask for sharing. That's the signal the other
answer was right, and it means pulling B forward immediately.
