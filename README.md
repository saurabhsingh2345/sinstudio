# Studio — Editing Engine

A non-linear video editor that **assembles** the clips produced by the sibling
projects (`newaniAdv`, `hyper/hyperframes`, `funkycode`) into a finished video:
generate/import clips → arrange on a multi-track timeline → add music, a
transcript/caption track, and background layers → **export an MP4 server-side
with FFmpeg**.

- **Backend:** Go (stdlib HTTP + SSE, Postgres project store, FFmpeg/ffprobe orchestration).
- **Frontend:** React + Vite + TypeScript (custom multi-track timeline, layered preview).
- **Render authority:** the edit is a declarative document; the browser previews it
  approximately, and Go compiles the *same* document into a deterministic FFmpeg filtergraph
  for the final export.
- **Concurrency:** the timeline is saved under an optimistic-concurrency revision, and the
  asset library is a separate table written by background jobs — so a finishing export can
  never be overwritten by an editor's autosave.

```
studio/
  backend/    Go API + generator orchestration + FFmpeg export
  frontend/   React editor (timeline, preview, assets, transcript, inspector)
  media/      per-project media: assets, thumbs, renders, luts  (gitignored)
```

## Prerequisites

- **Go** 1.26+, **Node** 20+, **FFmpeg + ffprobe** on `PATH` (used for probing, thumbnails, export).
- **Postgres** — `./dev.sh` starts one via `docker compose up -d postgres` (host port **5544**).
  Projects still living in `media/projects/*/timeline.json` are adopted automatically on first
  start; the JSON files are left untouched as a backup.
- The sibling generators live next to `studio/`:
  - `newaniAdv` — works out of the box (`npx tsx`).
  - `hyper/hyperframes` — build its CLI once: `cd ../hyper/hyperframes && bun install && bun run build`.
  - `funkycode` — headless generate via `npx tsx scripts/render-funky.mts` (run `npm install` once for playwright/esbuild/tsx).
- **Captions** are rendered to PNG in Go using a system font (Arial/Helvetica/DejaVu autodetected;
  override with `CAPTION_FONT=/path/to.ttf`). This works even on minimal FFmpeg builds that lack
  `libass`/`drawtext`.
- **Transcription (optional):** whisper.cpp (`brew install whisper-cpp`). Drop a ggml model into
  `studio/models/` (e.g. `curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`)
  and it is auto-discovered; `WHISPER_BIN`/`WHISPER_MODEL` env vars override. Videos with audio
  auto-transcribe into caption cues on import; the Captions panel button re-runs it manually.

## Run

```bash
./dev.sh                       # backend :8788 + frontend :5273
# open http://localhost:5273
```

Or production-style (Go serves the built UI):

```bash
cd frontend && npm install && npm run build
cd ../backend && go run ./cmd/studio -addr :8788
# open http://localhost:8788
```

## Deploy

**Docker (recommended).** The image bundles ffmpeg and serves the built UI:

```bash
STUDIO_TOKEN=change-me docker compose up --build
# open http://localhost:8788  → enter the token
```

Media persists in the `studio-media` volume (mounted at `/data`). To build/run
the image directly:

```bash
docker build -t studio .
docker run -p 8788:8788 -e STUDIO_TOKEN=change-me -v studio-media:/data studio
```

**Configuration (environment variables):**

| Var | Default | Effect |
| --- | --- | --- |
| `STUDIO_TOKEN` | *(unset)* | When set, the API and `/media` require a login. Browsers sign in once at the token screen (httpOnly session cookie); programmatic clients may send `Authorization: Bearer <token>`. **Unset = open**, intended for localhost only. |
| `STUDIO_ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS allowlist (e.g. `https://studio.example.com`). Unset ⇒ only `localhost`/`127.0.0.1` origins are allowed; the server never advertises `*`. |
| `STUDIO_DATABASE_URL` | *(required)* | Postgres connection string, e.g. `postgres://studio:studio@localhost:5544/studio?sslmode=disable`. The schema is applied on startup. |
| `STUDIO_EXPORT_WORKERS` | `2` | Concurrent ffmpeg exports. Further exports queue (each is a full FFmpeg process). |
| `STUDIO_PLUGIN_WORKERS` | `4` | Concurrent generator subprocesses (generate / re-render). |
| `STUDIO_TRANSCRIBE_WORKERS` | `1` | Concurrent whisper transcriptions. |

> ⚠️ The app supervises local dev-servers and reads/writes media. **Never expose
> it to the public internet without `STUDIO_TOKEN` set** (and TLS in front).

The sibling generators (`newaniAdv`, `hyperframes`, `funkycode`) are **not** in the
container; Generate/Library features that spawn them degrade gracefully (import,
edit, and export still work fully). Mount the siblings and set `-root` if you want
them.

## CI

`.github/workflows/ci.yml` runs on every push/PR: `go vet` + `go test -race` (with
ffmpeg installed so render/export tests run), the frontend typecheck + build, and a
Docker image build.

## Connectivity — Studio as the hub

Studio pulls from every product three ways:

1. **Generate** — spawn a generator's CLI from the Asset panel (adapters in
   `backend/internal/generator/adapters/*.json`).
2. **Library** — the **Library** button lists clips already rendered by the other products
   (`newaniAdv/renders`, `hyper/hyperframes/renders`, `hyper/app/.data/renders`,
   `hyper/app/public/template-previews`, `funkycode/public`) plus the ingest inbox. One click
   imports a clip into the project. See `internal/library`.
3. **Ingest ("Send to Studio")** — a universal endpoint any product can POST a finished clip to:

   ```js
   // drop-in for any product (e.g. funkycode after MediaRecorder produces a Blob)
   const fd = new FormData();
   fd.append("file", blob, "clip.mp4");
   fd.append("source", "funkycode");
   // add ?projectId=<id> to import straight into a project
   await fetch("http://localhost:8788/api/ingest", { method: "POST", body: fd });
   ```

   Ingested clips land in `media/inbox/` and appear under the Library's "Inbox" source.

## Control — export power

The export dialog (and `POST /api/projects/{id}/export`) accepts:

- **preset:** `""` (timeline size) · `shorts` (1080×1920) · `square` (1080×1080) · `4k` (3840×2160)
- **format:** `mp4` (H.264) · `webm` (VP9) · `gif` · `mov` (ProRes)
- **from / to:** export a time range only

Every long-running action — export, generate, re-render, transcribe — runs through a
**bounded work queue**, partitioned into lanes by the tooling it needs (`render` /
`plugin` / `transcribe`) so a 20-minute export can't starve a quick clip generation.
Each lane's concurrency is set independently (see the table above). The **Renders** panel shows queued/rendering jobs
(with cancel), a **retry** for failed ones, and a **history** of finished exports with
re-download/delete.

Per clip (inspector): **speed**, **fade in/out**, volume, transform, opacity,
color **effects**, a **3-band audio EQ** (low/mid/high), and a **color LUT**
(upload a `.cube`, applied on export via `lut3d`). A live **audio level meter** and
a toggleable **luma histogram scope** in the transport help judge sound and grade
while playing or scrubbing.

**Titles** (add a text clip): pick a font size/color/alignment/position, then an
**animation preset** (Fade · Fade up · Pop · Slide · Zoom) that writes coherent
entrance/exit motion, or a **text reveal** (Typewriter · Word by word) that builds
the text on progressively. Presets are plain keyframes/transitions, so they animate
identically in the live preview and the FFmpeg export; the reveal composites a
sequence of prefix PNGs server-side.

## Usability — shortcuts

`Space` play/pause · `S` split at playhead · `Delete` remove selection ·
`←/→` nudge playhead (`Shift` = 1s) · `⌘Z` / `⌘⇧Z` undo/redo.

## How it fits together

1. **Generate / import** clips in the Asset panel. Generation spawns the sibling CLI
   (`internal/generator/adapters/*.json` describe each one) and streams progress over SSE.
2. **Arrange** clips on the timeline (background / video / overlay / music / caption lanes):
   drag to move, drag edges to trim, drop assets onto lanes.
3. **Music / captions / background:** add an audio clip to the Music lane, transcribe or hand-write
   caption cues, set a background color/clip.
4. **Export:** `POST /api/projects/{id}/export` → `internal/render` compiles `timeline.json` into an
   FFmpeg filtergraph (trims, overlays, transition-ready, `amix` audio, PNG caption overlays) →
   downloadable MP4.

## Adding another generator

Drop a JSON manifest in `backend/internal/generator/adapters/` (it's embedded at build):

```json
{ "id": "mytool", "name": "My Tool", "cwd": "../mytool",
  "command": ["node", "cli.js", "--in", "{input}", "--out", "{output}"],
  "inputKind": "json", "inputExt": ".json", "outputExt": "mp4",
  "params": [{ "flag": "--fps", "label": "FPS", "type": "string", "default": "30" }] }
```

## Key files

- `backend/internal/schema` — the edit-document types (source of truth; mirrored in `frontend/src/types.ts`).
- `backend/internal/render` — timeline → FFmpeg compiler + caption PNG renderer.
- `backend/internal/generator` — adapter registry + CLI orchestration.
- `frontend/src/state.ts` — Zustand edit-doc store with debounced autosave.
- `frontend/src/components/Timeline.tsx` — the custom multi-track timeline.
