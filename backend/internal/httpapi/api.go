// Package httpapi exposes the studio backend over REST + SSE.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"studio/internal/apps"
	"studio/internal/generator"
	"studio/internal/jobs"
	"studio/internal/library"
	"studio/internal/media"
	"studio/internal/render"
	"studio/internal/schema"
	"studio/internal/store"
	"studio/internal/transcribe"
)

// maxUploadBytes caps a single multipart upload (import/ingest) so a client
// can't fill the disk. 4 GiB covers long 4K clips with headroom.
const maxUploadBytes = 4 << 30

// Server bundles the backend dependencies.
type Server struct {
	Store          *store.Store
	Jobs           *jobs.Manager
	Gens           *generator.Registry
	Lib            *library.Scanner
	Apps           *apps.Manager
	FrontDir       string   // optional built frontend to serve (SPA)
	Auth           *Auth    // optional shared-token gate (nil/empty = open)
	AllowedOrigins []string // CORS allowlist ("" entry or empty = localhost dev only)

	// Per-lane worker concurrency; see the lane constants in queue.go.
	ExportWorkers     int // ffmpeg exports (default 2)
	PluginWorkers     int // generator subprocesses (default 4)
	TranscribeWorkers int // whisper (default 1)

	work     *workQueue
	workOnce sync.Once
}

// queue lazily builds the bounded work queue on first use.
func (s *Server) queue() *workQueue {
	s.workOnce.Do(func() {
		s.work = newWorkQueue(s, map[string]int{
			laneRender:     orDefault(s.ExportWorkers, 2),
			lanePlugin:     orDefault(s.PluginWorkers, 4),
			laneTranscribe: orDefault(s.TranscribeWorkers, 1),
		})
	})
	return s.work
}

func orDefault(n, def int) int {
	if n < 1 {
		return def
	}
	return n
}

// Routes builds the HTTP handler.
func (s *Server) Routes() http.Handler {
	if s.Auth == nil {
		s.Auth = NewAuth("")
	}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("GET /api/auth", s.authState)
	mux.HandleFunc("GET /api/capabilities", s.capabilities)
	mux.HandleFunc("GET /api/generators", s.listGenerators)
	mux.HandleFunc("GET /api/plugins", s.pluginState)
	mux.HandleFunc("POST /api/plugins/reload", s.reloadPlugins)

	// Sibling-app supervisor: run/manage newaniAdv, funkycode, hyperframes.
	mux.HandleFunc("GET /api/apps", s.listApps)
	mux.HandleFunc("POST /api/apps/{id}/start", s.startApp)
	mux.HandleFunc("POST /api/apps/{id}/stop", s.stopApp)
	mux.HandleFunc("POST /api/apps/{id}/restart", s.restartApp)
	mux.HandleFunc("GET /api/apps/{id}/logs", s.appLogs)

	mux.HandleFunc("GET /api/projects", s.listProjects)
	mux.HandleFunc("POST /api/projects", s.createProject)
	mux.HandleFunc("GET /api/projects/{id}", s.getProject)
	mux.HandleFunc("PUT /api/projects/{id}", s.saveProject)

	mux.HandleFunc("POST /api/projects/{id}/assets", s.importAsset)
	mux.HandleFunc("DELETE /api/projects/{id}/assets/{assetId}", s.deleteAsset)
	mux.HandleFunc("POST /api/projects/{id}/generate", s.generate)
	mux.HandleFunc("POST /api/projects/{id}/rerender", s.rerender)
	mux.HandleFunc("POST /api/projects/{id}/transcribe", s.transcribe)
	mux.HandleFunc("POST /api/projects/{id}/export", s.export)
	mux.HandleFunc("GET /api/projects/{id}/waveform", s.waveform)
	mux.HandleFunc("GET /api/projects/{id}/frame", s.frame)
	mux.HandleFunc("GET /api/projects/{id}/renders", s.listRenders)
	mux.HandleFunc("DELETE /api/projects/{id}/renders/{name}", s.deleteRender)
	mux.HandleFunc("GET /api/projects/{id}/luts", s.listLUTs)
	mux.HandleFunc("POST /api/projects/{id}/luts", s.uploadLUT)
	mux.HandleFunc("DELETE /api/projects/{id}/luts/{name}", s.deleteLUT)

	// Cross-product library + universal ingest ("Send to Studio").
	mux.HandleFunc("GET /api/library", s.listLibrary)
	mux.HandleFunc("POST /api/projects/{id}/library/import", s.libraryImport)
	mux.HandleFunc("POST /api/ingest", s.ingest)

	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/jobs", s.listJobs)
	mux.HandleFunc("GET /api/jobs/{id}", s.getJob)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", s.cancelJob)
	mux.HandleFunc("POST /api/jobs/{id}/retry", s.retryJob)

	// Media files (assets, thumbs, renders).
	mux.Handle("GET /media/", http.StripPrefix("/media/",
		http.FileServer(http.Dir(s.Store.Root()))))

	// SPA fallback.
	mux.HandleFunc("GET /", s.spa)

	return s.withCORS(s.Auth.Middleware(mux))
}

// ---- basic handlers ----

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "time": time.Now().UTC()})
}

func (s *Server) listGenerators(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Gens.List())
}

// capabilities reports optional features that depend on external tooling, so
// the UI can gate auto-behaviors (e.g. auto-transcribe) instead of surfacing a
// failure for every import on a machine without whisper.cpp.
func (s *Server) capabilities(w http.ResponseWriter, r *http.Request) {
	transcribeErr := ""
	if err := transcribe.Available(); err != nil {
		transcribeErr = err.Error()
	}
	writeJSON(w, 200, map[string]any{
		"transcribe":      transcribeErr == "",
		"transcribeError": transcribeErr,
	})
}

// pluginState reports the runtime plugin directory and any manifests that failed
// to load, so a broken plugin is visible in the UI instead of silently absent.
func (s *Server) pluginState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"dir":    s.Gens.PluginDir(),
		"errors": s.Gens.Errors(),
	})
}

// reloadPlugins re-scans the plugin directory, so editing a manifest doesn't
// need a restart.
func (s *Server) reloadPlugins(w http.ResponseWriter, r *http.Request) {
	s.Gens.Reload()
	writeJSON(w, 200, map[string]any{
		"generators": len(s.Gens.List()),
		"errors":     s.Gens.Errors(),
	})
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.Store.ListProjects(r.Context())
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, list)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	doc, err := s.Store.CreateProject(r.Context(), body.Name)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, doc)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	// Backfill hasAudio for assets that predate the field so the UI can flag
	// silent clips. Persisted on the asset row rather than left for the client to
	// save back: the client's PUT no longer carries the asset set at all, and an
	// asset write doesn't touch the project revision, so this can't conflict with
	// an editor's in-flight save.
	for i := range doc.Assets {
		a := &doc.Assets[i]
		if a.HasAudio != nil || (a.Kind != "video" && a.Kind != "audio") {
			continue
		}
		if info, err := probeCached(r.Context(), s.Store.Abs(a.Path)); err == nil {
			has := info.HasAudio
			a.HasAudio = &has
			// Persist it on the asset row. Previously this was in-memory only and
			// relied on the client saving the doc back, which no longer carries
			// the asset set at all.
			if err := s.Store.UpdateAsset(r.Context(), doc.ID, *a); err != nil {
				log.Printf("backfill hasAudio for %s: %v", a.ID, err)
			}
		}
	}
	writeJSON(w, 200, doc)
}

func (s *Server) saveProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var doc schema.EditDoc
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		httpErr(w, 400, err)
		return
	}
	doc.ID = id
	// The client sends the revision it loaded; if the stored one has moved on,
	// someone else saved this timeline in between and blindly overwriting would
	// silently discard their work. Answer 409 with the current document so the
	// client can show the conflict and reload.
	revision, err := s.Store.SaveProject(r.Context(), &doc, doc.Version)
	switch {
	case errors.Is(err, store.ErrConflict):
		current, cerr := s.Store.GetProject(r.Context(), id)
		if cerr != nil {
			httpErr(w, 500, cerr)
			return
		}
		writeJSON(w, 409, map[string]any{
			"error":   "project was modified by someone else",
			"current": current,
		})
		return
	case errors.Is(err, store.ErrNotFound):
		httpErr(w, 404, err)
		return
	case err != nil:
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": revision})
}

// ---- assets ----

// importAsset accepts a multipart file upload, probes it, makes a thumbnail,
// and registers it on the project.
func (s *Server) importAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), id); err != nil {
		httpErr(w, 404, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		httpErr(w, 400, err)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	defer file.Close()

	dir, _ := s.Store.AssetsDir(id)
	ext := filepath.Ext(header.Filename)
	assetID := store.NewID("asset_")
	dst := filepath.Join(dir, assetID+ext)
	out, err := os.Create(dst)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	if _, err := io.Copy(out, file); err != nil {
		out.Close()
		httpErr(w, 500, err)
		return
	}
	out.Close()

	asset, err := s.registerAsset(r.Context(), id, assetID, dst, header.Filename, "import")
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	if err := s.Store.AddAsset(r.Context(), id, *asset); err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": asset})
}

// deleteAsset removes an asset from a project. The removal is a soft delete and
// the media file is deliberately left on disk: an accidental removal costs
// nothing to undo, and any finished render still referencing the file keeps
// working. Reclaiming the bytes is a separate, deliberate step.
//
// This exists because the asset set no longer round-trips through the client's
// document save — dropping an asset from the PUT body is now a no-op.
func (s *Server) deleteAsset(w http.ResponseWriter, r *http.Request) {
	err := s.Store.DeleteAsset(r.Context(), r.PathValue("id"), r.PathValue("assetId"))
	if errors.Is(err, store.ErrNotFound) {
		httpErr(w, 404, fmt.Errorf("unknown asset"))
		return
	}
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// registerAsset probes a file and builds an Asset (with thumbnail).
func (s *Server) registerAsset(ctx context.Context, projID, assetID, path, name, source string) (*schema.Asset, error) {
	info, err := media.Probe(ctx, path)
	if err != nil {
		return nil, err
	}
	asset := &schema.Asset{
		ID:        assetID,
		Name:      name,
		Kind:      info.Kind,
		Path:      s.Store.Rel(path),
		Duration:  info.Duration,
		Width:     info.Width,
		Height:    info.Height,
		HasAlpha:  info.HasAlpha,
		HasAudio:  &info.HasAudio,
		Source:    source,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if info.Kind != "audio" {
		thumbs, _ := s.Store.ThumbsDir(projID)
		thumb := filepath.Join(thumbs, assetID+".jpg")
		at := 0.0
		if info.Duration > 1 {
			at = info.Duration / 2
		}
		if err := media.Thumbnail(ctx, path, thumb, at); err == nil {
			asset.Thumbnail = s.Store.Rel(thumb)
		}
	}
	return asset, nil
}

// ---- generation ----

func (s *Server) generate(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	var body struct {
		GeneratorID string            `json:"generatorId"`
		Input       string            `json:"input"`
		Params      map[string]string `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, 400, err)
		return
	}
	jobID, err := s.queue().Enqueue(r.Context(), generatePayload{
		ProjID:      projID,
		GeneratorID: body.GeneratorID,
		Input:       body.Input,
		Params:      body.Params,
	})
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID})
}

// rerender regenerates an existing generated asset in place: it re-runs the
// asset's original generator with (possibly edited) input/params, overwrites the
// same media file, and refreshes the asset's probed metadata. Every clip that
// references the asset picks up the new render. The generator id is read from the
// asset's Source, so the client only sends the (edited) input + params.
func (s *Server) rerender(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	doc, err := s.Store.GetProject(r.Context(), projID)
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	var body struct {
		AssetID string            `json:"assetId"`
		Input   string            `json:"input"`
		Params  map[string]string `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, 400, err)
		return
	}
	var asset *schema.Asset
	for i := range doc.Assets {
		if doc.Assets[i].ID == body.AssetID {
			asset = &doc.Assets[i]
			break
		}
	}
	if asset == nil {
		httpErr(w, 404, fmt.Errorf("unknown asset %q", body.AssetID))
		return
	}

	jobID, err := s.queue().Enqueue(r.Context(), rerenderPayload{
		ProjID:  projID,
		AssetID: asset.ID,
		Source:  asset.Source,
		Name:    asset.Name,
		Input:   body.Input,
		Params:  body.Params,
	})
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID})
}

// ---- transcription ----

func (s *Server) transcribe(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	doc, err := s.Store.GetProject(r.Context(), projID)
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	var body struct {
		AssetID string `json:"assetId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, 400, err)
		return
	}
	var srcRel string
	for _, a := range doc.Assets {
		if a.ID == body.AssetID {
			srcRel = a.Path
		}
	}
	if srcRel == "" {
		httpErr(w, 404, fmt.Errorf("asset not found"))
		return
	}

	jobID, err := s.queue().Enqueue(r.Context(), transcribePayload{ProjID: projID, SrcRel: srcRel})
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID})
}

// ---- export ----

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	doc, err := s.Store.GetProject(r.Context(), projID)
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	var opts render.Options
	_ = json.NewDecoder(r.Body).Decode(&opts) // body optional

	// Route through the bounded render lane (compiles now, fails fast on bad opts).
	jobID, err := s.queue().Enqueue(r.Context(), exportPayload{ProjID: projID, Doc: doc, Opts: opts})
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID})
}

// retryJob re-runs a previously-submitted task as a fresh queued job, with the
// same inputs. Works for any queued kind, not just exports.
func (s *Server) retryJob(w http.ResponseWriter, r *http.Request) {
	jobID, err := s.queue().Retry(r.Context(), r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	writeJSON(w, 202, map[string]any{"jobId": jobID})
}

// ---- jobs ----

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Jobs.List())
}

// getJob lets a client that missed a terminal SSE event recover the job's final
// state (done/error/canceled) by polling.
func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.Jobs.Get(r.PathValue("id"))
	if !ok {
		httpErr(w, 404, fmt.Errorf("unknown job"))
		return
	}
	writeJSON(w, 200, job)
}

// cancelJob aborts a running job and kills its subprocess.
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	if !s.Jobs.Cancel(r.PathValue("id")) {
		httpErr(w, 404, fmt.Errorf("unknown job"))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---- SSE ----

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpErr(w, 500, fmt.Errorf("streaming unsupported"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, cancel := s.Jobs.Subscribe()
	defer cancel()

	fmt.Fprintf(w, ": connected\n\n")
	flusher.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprintf(w, ": ping\n\n")
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", jobs.Encode(ev))
			flusher.Flush()
		}
	}
}

// ---- SPA ----

func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if s.FrontDir == "" {
		writeJSON(w, 200, map[string]any{"service": "studio", "hint": "frontend dev server runs on Vite; build to FrontDir to serve here"})
		return
	}
	p := filepath.Join(s.FrontDir, filepath.Clean(r.URL.Path))
	if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
		http.ServeFile(w, r, p)
		return
	}
	http.ServeFile(w, r, filepath.Join(s.FrontDir, "index.html"))
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

// withCORS reflects an Origin only if it's in the configured allowlist. With no
// allowlist, it permits localhost/127.0.0.1 origins on any port (dev), so a
// deployed instance never advertises "*" and only the origins you list can make
// credentialed cross-origin calls.
func (s *Server) withCORS(h http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range s.AllowedOrigins {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (allowed[origin] || (len(allowed) == 0 && isLocalOrigin(origin))) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// isLocalOrigin matches http(s)://localhost:* and 127.0.0.1:* for dev.
func isLocalOrigin(origin string) bool {
	host := origin
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.Index(host, ":"); i >= 0 {
		host = host[:i]
	}
	return host == "localhost" || host == "127.0.0.1"
}
