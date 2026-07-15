// Command studio runs the editing-engine backend: REST + SSE over HTTP, with a
// filesystem project store and orchestration of the sibling clip generators.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"studio/internal/apps"
	"studio/internal/generator"
	"studio/internal/httpapi"
	"studio/internal/jobs"
	"studio/internal/library"
	"studio/internal/store"
	"studio/internal/transcribe"
)

func main() {
	addr := flag.String("addr", ":8787", "listen address")
	root := flag.String("root", "..", "studio project root (parent of backend/); used to locate sibling generators")
	mediaDir := flag.String("media", "", "media root (default <root>/media)")
	frontDir := flag.String("front", "", "built frontend dir to serve (default <root>/frontend/dist if present)")
	flag.Parse()

	absRoot, err := filepath.Abs(*root)
	if err != nil {
		log.Fatalf("resolve root: %v", err)
	}
	// Whisper models are auto-discovered in <root>/models when WHISPER_MODEL
	// isn't set, so transcription works out of the box once a ggml-*.bin lands there.
	transcribe.SetDefaultModelDir(filepath.Join(absRoot, "models"))

	media := *mediaDir
	if media == "" {
		media = filepath.Join(absRoot, "media")
	}
	st, err := store.New(media)
	if err != nil {
		log.Fatalf("store: %v", err)
	}

	reg, err := generator.NewRegistry(absRoot)
	if err != nil {
		log.Fatalf("generators: %v", err)
	}

	// Watch dirs where the sibling apps drop browser-downloaded clips (so they
	// can auto-import). The user's Downloads folder is watched by default;
	// STUDIO_WATCH_DIRS (comma-separated) adds custom drop folders.
	var watch []library.Source
	if home, err := os.UserHomeDir(); err == nil {
		watch = append(watch, library.Source{ID: "downloads", Name: "Downloads", Dir: filepath.Join(home, "Downloads")})
	}
	if v := strings.TrimSpace(os.Getenv("STUDIO_WATCH_DIRS")); v != "" {
		for i, d := range strings.Split(v, ",") {
			if d = strings.TrimSpace(d); d != "" {
				watch = append(watch, library.Source{ID: fmt.Sprintf("watch%d", i+1), Name: filepath.Base(d), Dir: d})
			}
		}
	}
	lib := library.New(absRoot, filepath.Join(st.Root(), "inbox"), watch)

	appMgr, err := apps.NewManager(absRoot)
	if err != nil {
		log.Fatalf("apps: %v", err)
	}

	front := *frontDir
	if front == "" {
		cand := filepath.Join(absRoot, "frontend", "dist")
		if fi, err := os.Stat(cand); err == nil && fi.IsDir() {
			front = cand
		}
	}

	// Deployment config from the environment. STUDIO_TOKEN gates the API when set
	// (unset = open, for localhost dev). STUDIO_ALLOWED_ORIGINS is a comma list of
	// CORS origins (empty = localhost dev origins only).
	auth := httpapi.NewAuth(os.Getenv("STUDIO_TOKEN"))
	var origins []string
	if v := strings.TrimSpace(os.Getenv("STUDIO_ALLOWED_ORIGINS")); v != "" {
		origins = strings.Split(v, ",")
	}
	exportWorkers := 2
	if v := strings.TrimSpace(os.Getenv("STUDIO_EXPORT_WORKERS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			exportWorkers = n
		}
	}

	jobMgr := jobs.NewManager()
	srv := &httpapi.Server{
		Store:          st,
		Jobs:           jobMgr,
		Gens:           reg,
		Lib:            lib,
		Apps:           appMgr,
		FrontDir:       front,
		Auth:           auth,
		AllowedOrigins: origins,
		ExportWorkers:  exportWorkers,
	}

	log.Printf("studio backend on %s", *addr)
	log.Printf("  root=%s", absRoot)
	log.Printf("  media=%s", st.Root())
	for _, a := range reg.List() {
		log.Printf("  generator %-12s available=%v (%s)", a.ID, a.Available, a.CWD)
	}
	for _, src := range lib.Sources() {
		log.Printf("  library   %-16s %s", src.ID, src.Dir)
	}
	if front != "" {
		log.Printf("  serving frontend from %s", front)
	}
	if auth.Enabled() {
		log.Printf("  auth       ENABLED (STUDIO_TOKEN set)")
	} else {
		log.Printf("  auth       open (set STUDIO_TOKEN to require a login)")
	}
	if len(origins) > 0 {
		log.Printf("  cors       allowlist=%v", origins)
	} else {
		log.Printf("  cors       localhost dev origins only")
	}

	// Graceful shutdown: on SIGINT/SIGTERM, stop accepting connections, cancel
	// in-flight jobs, and stop every supervised sibling app so nothing is orphaned.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := &http.Server{Addr: *addr, Handler: srv.Routes()}
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down…")
	jobMgr.CancelAll()
	appMgr.StopAll()
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
