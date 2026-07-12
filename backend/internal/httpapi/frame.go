package httpapi

import (
	"net/http"
	"os/exec"
	"path/filepath"
	"strconv"

	"studio/internal/render"
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
	out := filepath.Join(renders, "frame.png")
	opts := render.Options{FrameAt: t, Preset: r.URL.Query().Get("preset")}
	plan, err := render.Compile(doc, resolve, out, renders, opts)
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	if b, err := exec.CommandContext(r.Context(), "ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		httpErr(w, 500, &ffmpegError{string(b)})
		return
	}
	// Cache-bust so the browser re-fetches after each render.
	writeJSON(w, 200, map[string]any{"url": "/media/" + s.Store.Rel(out) + "?t=" + strconv.FormatFloat(t, 'f', 3, 64)})
}

type ffmpegError struct{ msg string }

func (e *ffmpegError) Error() string {
	if len(e.msg) > 400 {
		return e.msg[len(e.msg)-400:]
	}
	return e.msg
}
