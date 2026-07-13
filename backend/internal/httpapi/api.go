// Package httpapi exposes the studio backend over REST + SSE.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

// Server bundles the backend dependencies.
type Server struct {
	Store    *store.Store
	Jobs     *jobs.Manager
	Gens     *generator.Registry
	Lib      *library.Scanner
	Apps     *apps.Manager
	FrontDir string // optional built frontend to serve (SPA)
}

// Routes builds the HTTP handler.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/generators", s.listGenerators)

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
	mux.HandleFunc("POST /api/projects/{id}/generate", s.generate)
	mux.HandleFunc("POST /api/projects/{id}/transcribe", s.transcribe)
	mux.HandleFunc("POST /api/projects/{id}/export", s.export)
	mux.HandleFunc("GET /api/projects/{id}/waveform", s.waveform)
	mux.HandleFunc("GET /api/projects/{id}/frame", s.frame)

	// Cross-product library + universal ingest ("Send to Studio").
	mux.HandleFunc("GET /api/library", s.listLibrary)
	mux.HandleFunc("POST /api/projects/{id}/library/import", s.libraryImport)
	mux.HandleFunc("POST /api/ingest", s.ingest)

	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/jobs", s.listJobs)
	mux.HandleFunc("GET /api/jobs/{id}", s.getJob)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", s.cancelJob)

	// Media files (assets, thumbs, renders).
	mux.Handle("GET /media/", http.StripPrefix("/media/",
		http.FileServer(http.Dir(s.Store.Root()))))

	// SPA fallback.
	mux.HandleFunc("GET /", s.spa)

	return withCORS(mux)
}

// ---- basic handlers ----

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "time": time.Now().UTC()})
}

func (s *Server) listGenerators(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Gens.List())
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.Store.ListProjects()
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
	doc, err := s.Store.CreateProject(body.Name)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, doc)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.GetProject(r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
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
	if err := s.Store.SaveProject(&doc); err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": doc.Version})
}

// ---- assets ----

// importAsset accepts a multipart file upload, probes it, makes a thumbnail,
// and registers it on the project.
func (s *Server) importAsset(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := s.Store.GetProject(id); err != nil {
		httpErr(w, 404, err)
		return
	}
	if err := r.ParseMultipartForm(1 << 30); err != nil {
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
	doc, err := s.Store.AddAsset(id, *asset)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": asset, "version": doc.Version})
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
	if _, err := s.Store.GetProject(projID); err != nil {
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
	adapter, ok := s.Gens.Get(body.GeneratorID)
	if !ok {
		httpErr(w, 400, fmt.Errorf("unknown generator %q", body.GeneratorID))
		return
	}

	job := s.Jobs.New("generate", 15*time.Minute)
	dir, _ := s.Store.AssetsDir(projID)
	assetID := store.NewID("asset_")
	out := filepath.Join(dir, assetID+"."+adapter.OutputExt)

	go func() {
		ctx := job.Context()
		job.Progress(0.05, "starting "+adapter.Name)
		if err := s.Gens.Generate(ctx, job, body.GeneratorID, body.Input, body.Params, out); err != nil {
			job.Fail(err)
			return
		}
		job.Progress(0.9, "registering clip")
		asset, err := s.registerAsset(ctx, projID, assetID, out, adapter.Name+" clip", body.GeneratorID)
		if err != nil {
			job.Fail(err)
			return
		}
		if _, err := s.Store.AddAsset(projID, *asset); err != nil {
			job.Fail(err)
			return
		}
		job.Done(map[string]any{"asset": asset})
	}()

	writeJSON(w, 202, map[string]any{"jobId": job.ID})
}

// ---- transcription ----

func (s *Server) transcribe(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	doc, err := s.Store.GetProject(projID)
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

	job := s.Jobs.New("transcribe", 30*time.Minute)
	go func() {
		ctx := job.Context()
		job.Progress(0.1, "extracting audio")
		work, err := os.MkdirTemp("", "studio-transcribe-*") // isolated scratch (avoids clobbering concurrent jobs)
		if err != nil {
			job.Fail(err)
			return
		}
		defer os.RemoveAll(work)
		cues, err := transcribe.Transcribe(ctx, s.Store.Abs(srcRel), work)
		if err != nil {
			job.Fail(err)
			return
		}
		job.Done(map[string]any{"cues": cues})
	}()
	writeJSON(w, 202, map[string]any{"jobId": job.ID})
}

// ---- export ----

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	doc, err := s.Store.GetProject(projID)
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	var opts render.Options
	_ = json.NewDecoder(r.Body).Decode(&opts) // body optional

	resolve := func(assetID string) (string, bool) {
		for _, a := range doc.Assets {
			if a.ID == assetID {
				return s.Store.Abs(a.Path), true
			}
		}
		return "", false
	}
	renders, _ := s.Store.RendersDir(projID)
	ext := opts.Format
	if ext == "" {
		ext = "mp4"
	}
	outName := "export-" + store.NewID("") + "." + ext
	outPath := filepath.Join(renders, outName)

	plan, err := render.Compile(doc, resolve, outPath, renders, opts)
	if err != nil {
		httpErr(w, 400, err)
		return
	}

	job := s.Jobs.New("export", 30*time.Minute)
	go func() {
		ctx := job.Context()
		job.Progress(0.02, "rendering")
		if err := render.Run(ctx, job, plan); err != nil {
			job.Fail(err)
			return
		}
		asset, err := s.registerAsset(ctx, projID, store.NewID("asset_"), outPath, "Export "+outName, "export")
		if err != nil {
			job.Fail(err)
			return
		}
		if _, err := s.Store.AddAsset(projID, *asset); err != nil {
			job.Fail(err)
			return
		}
		job.Done(map[string]any{"asset": asset, "url": "/media/" + s.Store.Rel(outPath)})
	}()
	writeJSON(w, 202, map[string]any{"jobId": job.ID})
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

func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		h.ServeHTTP(w, r)
	})
}
