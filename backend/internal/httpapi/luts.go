package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxLUTBytes = 32 << 20 // .cube files are small; cap to be safe

// listLUTs returns the .cube color LUTs uploaded to a project.
func (s *Server) listLUTs(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	dir, err := s.Store.LutsDir(projID)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	ents, _ := os.ReadDir(dir)
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".cube") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	writeJSON(w, 200, map[string]any{"luts": names})
}

// uploadLUT accepts a .cube file and stores it in the project's luts dir.
func (s *Server) uploadLUT(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxLUTBytes)
	if err := r.ParseMultipartForm(maxLUTBytes); err != nil {
		httpErr(w, 400, err)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpErr(w, 400, err)
		return
	}
	defer file.Close()

	name := filepath.Base(header.Filename)
	if !strings.EqualFold(filepath.Ext(name), ".cube") {
		httpErr(w, 400, fmt.Errorf("expected a .cube LUT file"))
		return
	}
	name = sanitizeToken(strings.TrimSuffix(name, filepath.Ext(name))) + ".cube"

	dir, err := s.Store.LutsDir(projID)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	out, err := os.Create(filepath.Join(dir, name))
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
	writeJSON(w, 200, map[string]any{"ok": true, "name": name})
}

// deleteLUT removes a project LUT (base-sanitized, must be a .cube).
func (s *Server) deleteLUT(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	name := filepath.Base(r.PathValue("name"))
	if !strings.EqualFold(filepath.Ext(name), ".cube") {
		httpErr(w, 400, fmt.Errorf("not a .cube file"))
		return
	}
	dir, err := s.Store.LutsDir(projID)
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
