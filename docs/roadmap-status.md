# Studio 10× Roadmap — Status

Last updated after plan execution pass.

## Phase 1 — Trust & Polish ✅

| # | Item | Status |
|---|------|--------|
| 1.1 | Wire wizard options | ✅ Solid/gradient + segments |
| 1.2 | Modernize legacy modals | ✅ StudioModal shell |
| 1.3 | Luma histogram scope | ✅ Transport bar toggle |
| 1.4 | Recording readiness panel | ✅ RecordingReadiness |
| 1.5 | Split StudioView | ✅ TopBar, LeftRail, PreviewStage, SpineArea, CenterColumn, InspectorPanel (~254-line root) |

## Phase 2 — Record → Done ✅

| # | Item | Status |
|---|------|--------|
| 2.1 | Record vs Edit / Review mode | ✅ Quick review after record |
| 2.2 | Style presets | ✅ Five presets + apply pipeline |
| 2.3 | Motion blur | ✅ Schema + FFmpeg tmix + preview hint |
| 2.4 | One-click social export | ✅ Export dialog quick picks |
| 2.5 | Post-record checklist | ✅ + auto review mode |

## Phase 3 — Recording Superpowers

| # | Item | Status |
|---|------|--------|
| 3.1 | cursord on Windows | ✅ `cursor_windows.go` (GetCursorPos) |
| 3.2 | Native recorder shell | ⏸️ Deferred (Tauri/Electron — XL) |
| 3.3 | Cursor smoothing | ✅ Inspector + autoFrame default 0.55 |
| 3.4 | Teleprompter | ✅ Record panel script + auto-scroll |
| 3.5 | Countdown | ✅ 3-2-1 before capture |

## Phase 4 — AI & Content Velocity ✅

| # | Item | Status |
|---|------|--------|
| 4.1 | Transcript panel editor | ✅ Seek + ripple-cut + filler removal |
| 4.2 | Caption styling presets | ✅ Five presets, apply to all |
| 4.3 | Smart chapter markers | ✅ Detect + YouTube format + timeline markers |
| 4.4 | Silence cut v2 | ✅ Gentle/normal/aggressive + preview list |
| 4.5 | B-roll from plugins | ✅ Gap detection + generate at playhead |

## Phase 5 — Ecosystem & Scale

| # | Item | Status |
|---|------|--------|
| 5.1 | Project templates | ✅ Wizard template step + 9:16 |
| 5.2 | Plugin gallery UX | ✅ Recent plugins + last settings |
| 5.3 | Share link / embed | ✅ Copy render URL (local/server) |
| 5.4 | Preview = export fidelity | ✅ Export frame check + fidelity notes |
| 5.5 | Optional local/SQLite mode | ✅ `STUDIO_DATABASE_URL=local` + `./dev-local.sh` |
| 5.6 | One installer + bundled cursord | ⏸️ Deferred (XL) |

## Video editing — remaining (post-pass)

| Item | Status |
|------|--------|
| Marker inspector (select, edit label/color, jump, **M** shortcut) | ✅ |
| StudioView split — all major panels | ✅ |
| Preview LUT parity audit (5.4 deep) | ⏸️ Optional polish |

## Deferred (explicit)

- **3.2 Native shell** — requires Tauri/Electron investment; browser recorder remains primary.
- **5.6 Bundled installer** — depends on 3.2.
- **Linux cursord** — stub reports unsupported; X11/Wayland port TBD.

## Dev commands

```bash
./dev.sh          # Postgres + backend + frontend
./dev-local.sh    # No Docker — filesystem project store
cd frontend && npm test
cd backend && go test ./...
./scripts/e2e-smoke.sh   # API + export smoke (backend on :8788)
```
