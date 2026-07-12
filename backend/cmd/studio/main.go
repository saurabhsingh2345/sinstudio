// Command studio runs the editing-engine backend: REST + SSE over HTTP, with a
// filesystem project store and orchestration of the sibling clip generators.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"studio/internal/apps"
	"studio/internal/generator"
	"studio/internal/httpapi"
	"studio/internal/jobs"
	"studio/internal/library"
	"studio/internal/store"
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

	lib := library.New(absRoot, filepath.Join(st.Root(), "inbox"))

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

	srv := &httpapi.Server{
		Store:    st,
		Jobs:     jobs.NewManager(),
		Gens:     reg,
		Lib:      lib,
		Apps:     appMgr,
		FrontDir: front,
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

	if err := http.ListenAndServe(*addr, srv.Routes()); err != nil {
		log.Fatal(err)
	}
}
