# Can Studio be sold? — a plan

Written 2026-08-21, from a market survey plus the code. Amends
`best-in-class-plan.md` (2026-07-27) rather than replacing it: that document's
engineering judgements still hold, its *audience* decision has been overtaken by
events, because the recorder is being spun out into a separate product
(`~/Desktop/screenStudioclone/plan.md`, decided 2026-08-21).

---

## 1. The question, and the honest answer

> "This studio one also has potential, right? If some features get added and some
> get improved, this could sell as a nice video editing software."

**The potential is real. "A nice video editing software" is the one way to spend
it badly.**

Everything Studio needs to become a competitive browser NLE, it needs *in
addition* to the things that are already the best part of it. Everything it needs
to become a **video engine for agents and applications**, it mostly already is.
Those are not equally good bets, and the gap between them is not close.

---

## 2. Why "a nice video editing software" is the option to reject

Not pessimism — arithmetic. Four reasons, in descending order of how badly each
one hurts.

**2.1 The competition is free and bundled, which is the worst market shape there
is.** CapCut is free with the biggest template library. DaVinci Resolve is free
and genuinely professional. Clipchamp Premium is $11.99/month standalone, but
Microsoft 365 Personal is **$9.99/month and includes it** — plus Word, Excel,
PowerPoint, Outlook and 1TB of OneDrive. To sell a paid NLE you must beat a
product a hundred million people already own as a rounding error on a
subscription they bought for something else. The paid tier of this market —
Descript $16, Kapwing $16, VEED $12 — survives by being *specifically* better at
one thing (transcript editing, collaboration, subtitles), not by being a good
editor.

**2.2 Studio's own assessment already answered this.**
`best-in-class-plan.md` §1 scores it Behind on the playback engine
("**structural**"), collaboration ("**absent**"), media management, audio
finishing, colour, and editing feel — six areas of catch-up. Its own verdict:
"best-in-class recorder, respectable NLE, non-competitive platform", and its own
§6: **"Being the 20th passable NLE is not a position."** That was right in July
and nothing since has made it wrong.

**2.3 The parts that are genuinely world-class are leaving.** The recorder,
SmartFocus, the spring camera, cursor drawing — the assessment's two
"**Top of field**" rows — are the foundation of Prism. What remains, considered
purely as an NLE, is the *respectable* part. Selling the respectable part while
the exceptional part ships as a different product is the wrong half.

**2.4 Two products from one codebase, competing for the same buyer, is how both
die.** Prism's audience is teams making tutorials and product docs. That is
exactly the buyer a "nice video editor" would chase. Same code, same market, half
the attention each.

**Where a vertical NLE *would* work**, for the record: vertical SaaS reports
**35–60% higher retention** than horizontal, and bootstrapped products have a
**45% five-year survival rate against 25% for venture-funded**. Niche wins. But
Prism *is* the vertical bet — tutorials and product docs — and it is already
funded with your attention. A second vertical is a second company.

---

## 3. What Studio actually has that is rare

Set the UI aside and look at what the repository is:

> **A declarative edit document that compiles deterministically into a finished
> video, with the geometry proved by golden tests in two languages, behind a
> lane-partitioned job queue, with a plugin system for generators and an ingest
> endpoint — and no browser required to run any of it.**

Concretely:

| Asset | Where | Why it is rare |
|---|---|---|
| **A validated, versioned edit document** | `internal/schema/schema.go` (782) + `migrate.go` — clips, keyframes, anchored transforms, crop/fit/fill-focus, cursor FX, backdrops, device frames, chroma, annotations, redactions, captions, LUTs, EQ, denoise, watermark | Everyone else's JSON timeline is a private format with a thin schema. This one has one-time document migrations (`schemaRev`) already, which is what a *long-lived* format needs |
| **A deterministic compiler, tested at the pixel** | `internal/render/*` — 12,156 LOC, 55 files, roughly half tests, including `crop_pixel_test`, `anchor_pixel_test`, `crossfade_pixel_test`, `letterbox_test`, `springzoom_test`, `device_test`, `backdrop_test`, real dB and edge-energy assertions | Same document → same frames, and it is *proved*, not hoped. This is the single hardest thing to reproduce and the only reason to trust an automated render |
| **A bounded, lane-partitioned work queue** | `httpapi/queue.go` (568) + `internal/jobs` — render / plugin / transcribe lanes with independent concurrency, cancel, retry, SSE progress | The unglamorous half of every render API, already built and already the thing customers actually pay for |
| **A generator plugin contract** | `internal/generator` + `adapters/*.json`, and `FieldSpec` — "the schema is a *view* over the document, not a model of it", so a generator can carry properties Studio doesn't know about without destroying them | This is a correct and unusual design decision. It is what makes third-party generators safe |
| **An ingest endpoint** | `POST /api/ingest` — any producer can post a finished clip | The integration surface, already generic |
| **Deployability** | Dockerfile, Postgres *or* filesystem store (`STUDIO_DATABASE_URL=local`), token auth, CORS allowlist, CI with `go test -race` and ffmpeg installed | Self-hosting is a feature you cannot bolt on later, and it is the one thing no cloud competitor can match |

And what is *bespoke* rather than valuable, worth naming so it isn't mistaken for
an asset: `internal/apps` (341 LOC) is a **process supervisor for your own
sibling dev servers** — it starts `npm run dev` in `../funkycode` and health-probes
it. That is a personal control room, not a product feature. The four adapters
(`funkycode`, `hyperframes`, `kokorovoice`, `newaniadv`) are your own tools. The
plugin *contract* generalises; those four don't.

---

## 4. Why this is the moment, specifically

The thing Studio is happens to be the thing 2026 is short of.

- a16z published **"It's time for agentic video editing"** — the premise being
  that **80% of production time is editing, 20% is filming**, and that vision
  models plus tool-using agents have only just crossed the line where an agent
  can drive real editing software.
- The research literature has converged on the same architecture Studio
  accidentally has: an agentic-video paper's central result is that the **LLM
  should do narrative planning while a programmatic backend enforces constraints
  through validated tool calls**, so that every specification produced is
  "executable by construction". A hand-written FFmpeg filtergraph is not
  executable by construction. A validated edit document with a golden-tested
  compiler is.
- The one production system doing this well (Reelful) has **LLM agents write
  Remotion compositions rather than manipulate video files**, explicitly because
  that yields "a deterministic, version-controllable representation of video
  edits". Studio has the deterministic representation *without* requiring the
  agent to write React.
- Screen Studio's **single most-requested feature, 23 votes, is agent-driven
  editing**. The demand is not hypothetical and it is not being served.

Meanwhile the market that *pays* for this already exists and prices are known:

| Competitor | What it is | Price |
|---|---|---|
| **Shotstack** | "JSON edit-decision-list API with a managed render cluster" — literally Studio's architecture, sold | **$0.01/render, $100/month minimum**; ~20s per finished minute |
| **Creatomate** | Template-based; design in their editor, populate by API | **~$54/month for ~143 minutes at 720p** after a 2026 increase |
| **Remotion** | Video as React code; open source with a licence | **$25/seat**, or $0.01/render; **free only under 4 employees** |
| **json2video / Rendi / others** | JSON templates, FFmpeg-as-a-service | **$0.10–$0.84 per 1080p minute** |

The stated reasons teams leave Remotion: **render infrastructure, cost at scale,
and needing a developer for every change.** Studio answers all three.

Market context: video-editing SaaS is **$3.37B in 2026 → $6.09B by 2030
(15.9% CAGR)**; AI video generation **$946M in 2026 → $3.44B by 2033 (20.3%)**.
The engine layer is a small slice of that, which is the point — it is a slice with
four competitors instead of forty, and its customers are developers, who evaluate
on capability rather than on template count.

---

## 5. The four options, scored

| | Option | What it is | Verdict |
|---|---|---|---|
| **A** | **Video engine + agent API** | The edit document as a product: self-hostable render API, MCP server, and the existing editor demoted to the *inspector* for what the API produced | **Recommended.** Mostly already built; four competitors not forty; developers buy on capability; and it composes with Prism instead of competing |
| **B** | **Vertical NLE for one niche** | Pick one industry and be irreplaceable to it | Genuinely viable — vertical SaaS retains 35–60% better — **but Prism is already this bet.** Revisit only if Prism's audience decision changes |
| **C** | **Fold entirely into Prism** | Studio becomes Prism's cloud render plane and dies as a separate product | **The correct default.** Lowest risk, real value, zero new surface. If Option A fails validation, do this |
| **D** | **General browser video editor** | Compete with CapCut, Clipchamp, Descript, VEED, Kapwing | **Reject.** §2 |

The insight that makes A cheap: **A and C are the same work for the first two
months.** Both need one schema, one IR, one set of executors, one parity harness —
which is exactly Prism's P0 and P3. Option A is Option C *plus an API surface and
an MCP server on top of a foundation you were building anyway.* That is why it
gets a validation spike instead of a rejection.

---

## 6. Option A, stated properly

**Studio is the engine. Prism is the hands.**

```
            shared/schema  —  ONE edit document, ONE RenderGraph IR
                     │                              │
        ┌────────────┴───────────┐      ┌───────────┴────────────┐
        ▼                        ▼      ▼                        ▼
   Prism (desktop)          Studio (engine)              executors
   capture + human edit     API · MCP · queue · plugins  wgpu (local)
   the hands                the engine                   ffmpeg (server)
                                                         shared .wgsl
```

Two products, one substrate, no cannibalisation: Prism sells to people who
record; Studio sells to people who generate. The same document, the same
executors, the same tests.

**What Studio-the-engine is:**

1. **A render API.** POST an edit document, get a job; poll or stream SSE; fetch
   the MP4. Already 80% built (`/api/projects`, export endpoint, queue, SSE).
2. **An MCP server** exposing the document as typed tools, with **propose → diff →
   accept**, never silent mutation. This is the differentiator, not a feature.
3. **A visual inspector** — the existing editor, repositioned. Shotstack's real
   weakness is that when a programmatic render comes out wrong you have a JSON
   blob and a bad MP4 and no way to see why. Studio can *open* the render, show
   the timeline that produced it, let you fix it by hand, and hand back the
   corrected document. **Nobody in this market has that**, and Studio has it
   already, by accident.
4. **Self-hostable.** Docker, your Postgres or no Postgres, your GPU, your files.
   The one thing Shotstack and Creatomate structurally cannot offer.
5. **A generator plugin ecosystem** — the existing contract, documented and
   opened.

**How it wins, competitor by competitor:**

| Against | Their strength | The counter |
|---|---|---|
| Shotstack | Managed cluster, fast, mature | Self-host with no per-render fee; **and you can see and fix the render** |
| Creatomate | Nice template editor | Not templates — a *full* edit document with keyframes, curves and a real timeline; and no 720p/143-minute ceiling |
| Remotion | Code is expressive; big community | **No React developer needed per change**; render infra included; **no company-size licence trap** at four employees |
| Raw FFmpeg | Total control, free | You don't hand-write filtergraphs, and the geometry is *proved* by pixel tests instead of eyeballed |
| Agent frameworks writing Remotion | Deterministic and versionable | Same property, without needing the agent to write and debug React — and with validated tool calls, so a malformed edit is rejected at the schema instead of at render time |

---

## 7. Sequencing — why this costs a third of what it looks like

**Do not start this as a parallel project.** Prism's P0 and P3 are this product's
foundation; building them twice is the failure mode.

| When | What | Whose budget |
|---|---|---|
| **Now** | Prism **P0** — `shared/schema` as the single source of truth, RenderGraph IR frozen, parity harness as a CI gate, codegen to Rust/Go | Prism's. Studio inherits it free |
| **Weeks 3–5** | **The validation spike** (§8). Runs against Studio *as it stands today* — no refactor, no new foundation | ~3 weeks, cheap, killable |
| Prism P1–P4 | The product you use daily gets built | Prism's |
| Prism **P3** | One IR, two executors, shared `.wgsl`, parity green. **This is the engine's render core** | Prism's. Studio inherits it free |
| **Only if the spike validated** | Engine phases E1–E4 (§9) | Studio's, and by now it is an API and a docs site on top of finished machinery |

Read that table again before doing anything: **the engine product's expensive
half is already on Prism's schedule.** That is the entire reason this is worth
considering at all rather than being a distraction.

---

## 8. The validation spike — 3 weeks, with a kill switch

The bet is *"developers and agents will pay for a self-hostable, inspectable,
deterministic video engine."* It is cheap to test and expensive to assume. Test
it on today's code.

**Build, in three weeks, on `main` as it stands:**

1. **A public render API** — `POST /v1/render` taking an edit document, returning
   a job; SSE progress; signed result URL. This is a thin, honest wrapper over
   `httpapi` + `queue.go` + `internal/render`. **No refactor.**
2. **An MCP server** — 8–10 tools over the document: `create_project`,
   `add_clip`, `set_transform`, `add_caption`, `apply_zoom`, `propose_edit`,
   `render`, `get_frame`. Propose-then-accept enforced at the tool boundary.
3. **A JSON-Schema spec of the edit document**, generated from
   `schema.go`, published — so an agent can be constrained by it rather than
   guessing at it.
4. **Three end-to-end demos**, each a genuine job someone pays for today:
   - *Release-notes video*: a changelog JSON → a narrated, captioned video.
   - *Bulk personalisation*: one document + 100 rows of CSV → 100 videos.
   - *Agent editing*: Claude Code, given a raw clip and a director prompt,
     produces a reviewable diff and a correct render.
5. **One landing page** stating the position, with the three demos on it and a
   `docker run` line that works.

**Kill criteria — write the numbers down before starting, and honour them:**

| Signal | Threshold | If missed |
|---|---|---|
| Do developers try it? | **25 people run the `docker run` line** within 4 weeks of the page going up | Kill. Fold to Option C |
| Does anyone want it hosted? | **5 people ask for a hosted version or pricing** | Kill. It is a library, not a business |
| Is the agent path real? | 10 director prompts produce correct renders **without hand-fixing the document** | Kill the MCP surface specifically; keep the API |
| Would anyone pay? | **3 conversations where someone names a budget**, unprompted | Kill. Interest is not demand |
| Does it cost you Prism? | Prism P1 slips **more than 2 weeks** | Kill immediately. Prism is the product you actually use |

Any two missed → Option C. That is not pessimism, it is the point of a spike: the
cheapest possible way to find out, with the decision pre-committed so it can't be
rationalised away later.

---

## 9. If validated — the engine phases

Only read this section if §8 passed. Each phase ships independently.

### E1 · The document as a public contract — 3 weeks

- Freeze **v1** of the edit document. Published JSON Schema, semver, and a
  written compatibility promise. `schemaRev` migrations already exist — document
  them as the *guarantee* they are.
- Retarget `internal/render` to consume the RenderGraph IR (Prism P3 produces it),
  so both products compile the same graph and the golden tests cover both.
- Real API surface: keys and scopes, quotas, idempotency keys, webhooks, signed
  URLs, an OpenAPI document. Retire the shared-password `auth.go`.
- SDKs generated from OpenAPI: TypeScript and Python. Nothing hand-written.

**Gate:** a developer who has never seen the repo renders a two-layer captioned
video from the published schema, using only the docs, in under 15 minutes — timed,
with someone watching.

### E2 · The inspector — 3 weeks

The differentiator. Nobody else can do this.

- **Open any render in the editor from its job id.** The document, the timeline,
  the frames, and the exact FFmpeg graph that produced them, side by side.
- **Fix it by hand, get the corrected document back** — a diff against what the
  API was sent, copyable straight into the caller's code.
- **Explain a frame**: click a pixel at 00:12 and see which clip, transform,
  keyframe and filter put it there. A render debugger, which is what programmatic
  video is missing and what makes the API trustworthy.

**Gate:** given a deliberately-wrong document and a bad output, a person finds the
cause and produces a corrected document in under five minutes, without reading
FFmpeg output.

### E3 · Agent-native — 3 weeks

- MCP promoted from spike to product: full tool coverage, propose→diff→accept at
  every boundary, dry-run rendering (a frame, not a video, to check a change).
- **Constrained generation**: the published JSON Schema as the agent's grammar, so
  malformed edits are rejected at the schema, not discovered at render — the
  "executable by construction" property the literature identifies as the whole
  trick.
- A **cost/time estimator** so an agent can choose between renders.
- Headless CLI for CI: regenerate every documentation video on release.

**Gate:** 25 director prompts across 5 project shapes, ≥90% producing a correct
render with no human edit to the document.

### E4 · Run it for other people — 4 weeks

- Hosted plane: object storage, api/worker split, GPU nodes (NVENC) with priority
  queues, per-key quotas, an export SLO published and measured.
- Self-host stays first-class: one `docker compose`, no phone-home, no licence
  check, feature-identical.
- Fix the known blocker in `best-in-class-plan.md` §H: plugin adapters use
  relative sibling paths and ship in no image.
- Plugin registry: the existing contract, documented, with three generators that
  are *not* yours as the proof it generalises.

**Gate:** 99% of renders under 3× realtime; a self-hosted install passes the same
conformance suite as the hosted one, run in CI.

---

## 10. Pricing, if it gets that far

Undercut on the axis competitors can't move: **infrastructure ownership.**

| Tier | Price | Notes |
|---|---|---|
| **Self-host** | **Free, no limits, no licence check** | The whole engine. Remotion's four-employee threshold is its most-complained-about property; not having one is free marketing |
| **Hosted** | usage-based, undercutting **$0.01/render with a $100/month minimum** — and **no minimum** | The minimum is what keeps small teams off Shotstack |
| **Team** | per-seat | The inspector, shared projects, brand kits, audit log |
| **Enterprise** | negotiated | Private deployment, SSO, SLA, support |

Free self-hosting is not generosity, it is distribution: developers adopt what
they can run before they can buy, and the hosted plane sells itself to whoever
gets tired of running it.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **It steals attention from Prism** | **Highest** | §8's fifth kill criterion is explicitly this, and it triggers immediate abandonment. Prism is the product you use every day; this one is a bet |
| Free self-hosting means nobody pays for hosting | High | It is Remotion's and Cap's model and both convert. If it doesn't convert here, the hosted plane is cut and this stays a library — a fine outcome |
| Two products, one schema, coupled releases | High | The schema is versioned with published compatibility rules from E1. Prism cannot ship a breaking document change unilaterally — that is a *feature* of one source of truth, but it needs the rule written down |
| Shotstack/Creatomate ship an inspector | Medium | They'd have to build an NLE. That is the moat, and it is the part that already exists |
| Developer-market sales is a different skill | Medium | Docs, demos and a working `docker run` line *are* the sales motion. If the E1 gate (15 minutes, unaided) can't be met, the market can't be reached |
| `internal/apps` and the four adapters look like product | Low | Named in §3 as bespoke. Delete `internal/apps` from any product build |

---

## 12. What this changes in `best-in-class-plan.md`

That document stays useful; two things in it are now wrong.

- **Its audience decision is superseded.** "Teams making tutorials, docs and
  product videos" is **Prism's** audience now, and Prism is where Phases A, C, D,
  E and I belong. Studio-as-a-product is aimed at developers and agents instead.
- **Its Phase B is no longer Studio's to fund.** "One render graph, two runtimes"
  was correctly identified as the keystone and correctly costed at 6–10 weeks.
  It is now Prism's P0 + P3, and Studio inherits it. That is the single biggest
  change to the economics of this whole question.

What survives unchanged, and should be re-read before E1: §2's IR reasoning, §4's
cross-cutting bars, and the auto-framing discoverability lesson.

---

## 13. Decisions log

| Date | Decision |
|---|---|
| 2026-07-27 | Audience: teams making tutorials, docs, product videos (`best-in-class-plan.md`) — **superseded 2026-08-21**, transferred to Prism |
| 2026-08-21 | The recorder and auto-polish become **Prism**, a separate native product |
| 2026-08-21 | **Studio will not be sold as a general video editor.** §2 |
| 2026-08-21 | Studio's product thesis is the **engine**: self-hostable render API + MCP + inspector. §6 |
| 2026-08-21 | **Nothing is built for it until Prism P0 is done and the §8 spike has passed its kill criteria.** Default outcome is Option C — Studio becomes Prism's cloud plane |

### Open

- Does the spike happen at all? It costs ~3 weeks and it is the only honest way
  to answer the question that opened this document. The recommendation is **yes,
  but after Prism P0** — the schema work makes the spike better *and* is needed
  regardless.
