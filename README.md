# Studio — Editing Engine

A non-linear video editor that **assembles** the clips produced by the sibling
projects (`newaniAdv`, `hyper/hyperframes`, `funkycode`) into a finished video:
generate/import clips → arrange on a multi-track timeline → add music, a
transcript/caption track, and background layers → **export an MP4 server-side
with FFmpeg**.

- **Backend:** Go (stdlib HTTP + SSE, filesystem project store, FFmpeg/ffprobe orchestration).
- **Frontend:** React + Vite + TypeScript (custom multi-track timeline, layered preview).
- **Render authority:** the edit is a declarative `timeline.json`; the browser previews it
  approximately, and Go compiles the *same* document into a deterministic FFmpeg filtergraph
  for the final export.

```
studio/
  backend/    Go API + generator orchestration + FFmpeg export
  frontend/   React editor (timeline, preview, assets, transcript, inspector)
  media/      per-project data: assets, thumbs, renders, timeline.json  (gitignored)
```

## Prerequisites

- **Go** 1.26+, **Node** 20+, **FFmpeg + ffprobe** on `PATH` (used for probing, thumbnails, export).
- The sibling generators live next to `studio/`:
  - `newaniAdv` — works out of the box (`npx tsx`).
  - `hyper/hyperframes` — build its CLI once: `cd ../hyper/hyperframes && bun install && bun run build`.
  - `funkycode` — headless generate via `npx tsx scripts/render-funky.mts` (run `npm install` once for playwright/esbuild/tsx).
- **Captions** are rendered to PNG in Go using a system font (Arial/Helvetica/DejaVu autodetected;
  override with `CAPTION_FONT=/path/to.ttf`). This works even on minimal FFmpeg builds that lack
  `libass`/`drawtext`.
- **Transcription (optional):** whisper.cpp. Set `WHISPER_BIN=/path/to/whisper-cli` and
  `WHISPER_MODEL=/path/to/ggml-*.bin`.

## Run

```bash
./dev.sh                       # backend :8787 + frontend :5273
# open http://localhost:5273
```

Or production-style (Go serves the built UI):

```bash
cd frontend && npm install && npm run build
cd ../backend && go run ./cmd/studio -addr :8787
# open http://localhost:8787
```

## Deploy

**Docker (recommended).** The image bundles ffmpeg and serves the built UI:

```bash
STUDIO_TOKEN=change-me docker compose up --build
# open http://localhost:8787  → enter the token
```

Media persists in the `studio-media` volume (mounted at `/data`). To build/run
the image directly:

```bash
docker build -t studio .
docker run -p 8787:8787 -e STUDIO_TOKEN=change-me -v studio-media:/data studio
```

**Configuration (environment variables):**

| Var | Default | Effect |
| --- | --- | --- |
| `STUDIO_TOKEN` | *(unset)* | When set, the API and `/media` require a login. Browsers sign in once at the token screen (httpOnly session cookie); programmatic clients may send `Authorization: Bearer <token>`. **Unset = open**, intended for localhost only. |
| `STUDIO_ALLOWED_ORIGINS` | *(unset)* | Comma-separated CORS allowlist (e.g. `https://studio.example.com`). Unset ⇒ only `localhost`/`127.0.0.1` origins are allowed; the server never advertises `*`. |

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
   await fetch("http://localhost:8787/api/ingest", { method: "POST", body: fd });
   ```

   Ingested clips land in `media/inbox/` and appear under the Library's "Inbox" source.

## Control — export power

The export dialog (and `POST /api/projects/{id}/export`) accepts:

- **preset:** `""` (timeline size) · `shorts` (1080×1920) · `square` (1080×1080) · `4k` (3840×2160)
- **format:** `mp4` (H.264) · `webm` (VP9) · `gif` · `mov` (ProRes)
- **from / to:** export a time range only

Per clip (inspector): **speed**, **fade in/out**, volume, transform, opacity.

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
