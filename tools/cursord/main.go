// Command cursord records pointer position and button state during a screen
// recording, so Studio can add cursor highlights, spotlights and click rings
// afterwards.
//
// It exists because neither half of Studio can see the pointer. A browser tab
// gets pixels from getDisplayMedia and no coordinates — the cursor is painted
// into the frame, not reported — and it cannot observe anything outside itself
// anyway. The Go backend could ask the OS, but it may be running in a container
// or on another machine, where "the pointer" is not the user's pointer.
//
// So this is a third piece, deliberately: a small optional binary on the same
// machine as the browser, which is the only vantage point that can see both the
// user's screen and their input. Studio probes for it and works without it —
// you get the recording, minus the cursor effects.
//
// It is a separate module from the backend on purpose. This needs cgo and
// per-OS code; the server is built CGO_ENABLED=0 with no platform files, and
// that should stay true.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"time"
)

const defaultAddr = "127.0.0.1:8791"

var tracker Tracker

func main() {
	addr := flag.String("addr", defaultAddr, "listen address (loopback only unless you know why)")
	flag.Parse()

	if !supported() {
		log.Printf("cursor tracking is not implemented on %s — /health will report it and Studio will hide the feature", platform)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("POST /start", handleStart)
	mux.HandleFunc("POST /stop", handleStop)
	mux.HandleFunc("OPTIONS /", handlePreflight)

	if err := warnIfNotLoopback(*addr); err != nil {
		log.Fatal(err)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}
	w, h := screenSize()
	log.Printf("cursord on %s  platform=%s supported=%v screen=%dx%d", *addr, platform, supported(), w, h)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

// warnIfNotLoopback refuses a non-loopback bind. This process reports where the
// user is pointing and when they click, continuously — that is keystroke-
// adjacent telemetry, and it should not be reachable from the network by
// accident.
func warnIfNotLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("bad -addr %q: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("refusing to bind all interfaces: cursord reports pointer position and clicks, so it listens on loopback only (try %s)", defaultAddr)
	}
	if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
		return fmt.Errorf("refusing to bind %s: cursord reports pointer position and clicks, so it listens on loopback only (try %s)", host, defaultAddr)
	}
	return nil
}

// allowedOrigin mirrors the backend's policy: any localhost origin, on any
// port, because Studio's dev server and its production build sit on different
// ones. A page from anywhere else must not be able to start pointer tracking —
// the browser enforces that for us as long as we don't echo its Origin back.
func allowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); allowedOrigin(o) {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		next.ServeHTTP(w, r)
	})
}

func handlePreflight(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	sw, sh := screenSize()
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"service":   "cursord",
		"version":   1,
		"platform":  platform,
		"supported": supported(),
		"clicks":    buttonsSupported(),
		"running":   tracker.Running(),
		"screen":    Screen{Width: sw, Height: sh},
	})
}

func handleStart(w http.ResponseWriter, r *http.Request) {
	if !supported() {
		writeJSON(w, 501, map[string]any{"ok": false, "error": "cursor tracking is not implemented on " + platform})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "session": tracker.Start()})
}

func handleStop(w http.ResponseWriter, r *http.Request) {
	rec := tracker.Stop()
	writeJSON(w, 200, map[string]any{"ok": true, "recording": rec})
}
