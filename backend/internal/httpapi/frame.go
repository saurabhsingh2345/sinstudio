package httpapi

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"studio/internal/render"
	"studio/internal/store"
)

// frame renders a single PNG frame of the composited timeline at ?t= (seconds),
// using the same FFmpeg filtergraph as export — a ground-truth "what will the
// export look like here" check against the approximate canvas preview.
func (s *Server) frame(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.GetProject(r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	t, _ := strconv.ParseFloat(r.URL.Query().Get("t"), 64)
	if t <= 0 {
		t = 0.001
	}
	resolve := func(assetID string) (string, bool) {
		for _, a := range doc.Assets {
			if a.ID == assetID {
				return s.Store.Abs(a.Path), true
			}
		}
		return "", false
	}
	renders, err := s.Store.RendersDir(doc.ID)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	// Unique per request so fast scrubbing can't race two ffmpeg writes onto one
	// file (which would serve a half-written / wrong frame). Prune only frames
	// older than a few seconds so a concurrent request's just-written frame (that
	// the client hasn't fetched yet) isn't deleted out from under it.
	for _, old := range prevFrames(renders) {
		if fi, err := os.Stat(old); err == nil && time.Since(fi.ModTime()) > 10*time.Second {
			_ = os.Remove(old)
		}
	}
	out := filepath.Join(renders, "frame-"+store.NewID("")+".png")
	lutDir, _ := s.Store.LutsDir(doc.ID)
	opts := render.Options{FrameAt: t, Preset: r.URL.Query().Get("preset"), LUTDir: lutDir}
	plan, err := render.Compile(doc, resolve, out, renders, opts)
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	if b, err := exec.CommandContext(r.Context(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		httpErr(w, 500, &ffmpegError{string(b)})
		return
	}
	writeJSON(w, 200, map[string]any{"url": "/media/" + s.Store.Rel(out)})
}

// prevFrames lists previously-rendered preview frames in a project's renders dir.
func prevFrames(dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, "frame-*.png"))
	return m
}

type ffmpegError struct{ msg string }

func (e *ffmpegError) Error() string {
	if len(e.msg) > 400 {
		return e.msg[len(e.msg)-400:]
	}
	return e.msg
}
