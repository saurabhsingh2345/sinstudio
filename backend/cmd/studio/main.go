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

// envInt reads a positive integer from the environment, falling back to def when
// unset or unparseable.
func envInt(key string, def int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func main() {
	// 8788, not 8787: a sibling project (courseSmith) serves on 8787, and because
	// Go binds the IPv6 wildcard the two can start simultaneously without either
	// failing — leaving which app you reach up to the browser's address-family choice.
	addr := flag.String("addr", ":8788", "listen address")
	root := flag.String("root", "..", "studio project root (parent of backend/); used to locate sibling generators")
	mediaDir := flag.String("media", "", "media root (default <root>/media)")
	frontDir := flag.String("front", "", "built frontend dir to serve (default <root>/frontend/dist if present)")
	pluginDir := flag.String("plugins", "", "runtime plugin dir, one <id>/plugin.json per plugin (default <root>/plugins)")
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
	dbURL := strings.TrimSpace(os.Getenv("STUDIO_DATABASE_URL"))
	if dbURL == "" {
		log.Fatal("STUDIO_DATABASE_URL is required (e.g. postgres://studio:studio@localhost:5544/studio?sslmode=disable); " +
			"`docker compose up -d postgres` starts one")
	}
	dbCtx, dbCancel := context.WithTimeout(context.Background(), 15*time.Second)
	st, err := store.New(dbCtx, dbURL, media)
	dbCancel()
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	// Adopt any pre-Postgres timeline.json documents. Idempotent and
	// non-destructive — the JSON files stay put as a backup.
	if n, err := st.ImportLegacy(context.Background()); err != nil {
		log.Fatalf("import legacy projects: %v", err)
	} else if n > 0 {
		log.Printf("imported %d legacy project(s) from timeline.json", n)
	}

	reg, err := generator.NewRegistry(absRoot)
	if err != nil {
		log.Fatalf("generators: %v", err)
	}
	// Layer runtime plugins over the built-in ones so adding a generator is a
	// dropped-in folder rather than a rebuild.
	plugins := *pluginDir
	if plugins == "" {
		plugins = strings.TrimSpace(os.Getenv("STUDIO_PLUGINS_DIR"))
	}
	if plugins == "" {
		plugins = filepath.Join(absRoot, "plugins")
	}
	reg.SetPluginDir(plugins)

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
	// Per-lane worker concurrency. Each lane is bounded separately so a long
	// export can't starve clip generation; tune per machine.
	exportWorkers := envInt("STUDIO_EXPORT_WORKERS", 2)
	pluginWorkers := envInt("STUDIO_PLUGIN_WORKERS", 4)
	transcribeWorkers := envInt("STUDIO_TRANSCRIBE_WORKERS", 1)

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

		ExportWorkers:     exportWorkers,
		PluginWorkers:     pluginWorkers,
		TranscribeWorkers: transcribeWorkers,
	}

	log.Printf("studio backend on %s", *addr)
	log.Printf("  root=%s", absRoot)
	log.Printf("  media=%s", st.Root())
	log.Printf("  plugins    %s", plugins)
	for _, a := range reg.List() {
		log.Printf("  generator %-12s available=%v (%s)", a.ID, a.Available, a.CWD)
	}
	// Surface bad manifests loudly: a plugin that failed to load is invisible in
	// the UI otherwise, and "my plugin didn't show up" is a miserable thing to debug.
	for _, e := range reg.Errors() {
		log.Printf("  PLUGIN ERROR %s: %s", e.Path, e.Error)
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
	log.Printf("  workers    render=%d plugin=%d transcribe=%d", exportWorkers, pluginWorkers, transcribeWorkers)

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
