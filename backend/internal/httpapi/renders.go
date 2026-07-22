package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// renderEntry describes one finished export on disk.
type renderEntry struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Size    int64  `json:"size"`
	Created string `json:"created"` // RFC3339 mtime
}

// listRenders returns a project's finished exports (newest first), so the UI can
// show a render history with re-download. Transient preview frames (frame-*.png)
// are excluded.
func (s *Server) listRenders(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	dir, err := s.Store.RendersDir(projID)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	ents, _ := os.ReadDir(dir)
	out := make([]renderEntry, 0, len(ents))
	for _, e := range ents {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "export-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, renderEntry{
			Name:    e.Name(),
			URL:     "/media/" + s.Store.Rel(filepath.Join(dir, e.Name())),
			Size:    info.Size(),
			Created: info.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00"),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	writeJSON(w, 200, map[string]any{"renders": out})
}

// deleteRender removes one finished export file. The name is base-sanitized and
// must be an export-* file so this can't be used to delete anything else.
func (s *Server) deleteRender(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	name := filepath.Base(r.PathValue("name"))
	if !strings.HasPrefix(name, "export-") {
		httpErr(w, 400, errBadRenderName)
		return
	}
	dir, err := s.Store.RendersDir(projID)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	if err := os.Remove(filepath.Join(dir, name)); err != nil {
		httpErr(w, 404, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

var errBadRenderName = &renderErr{"not an export file"}

type renderErr struct{ msg string }

func (e *renderErr) Error() string { return e.msg }
