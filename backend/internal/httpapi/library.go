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

	"studio/internal/store"
)

// listLibrary returns clips discovered across all sibling products + the inbox.
func (s *Server) listLibrary(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{
		"sources": s.Lib.Sources(),
		"entries": s.Lib.Scan(300),
	})
}

// libraryImport copies a discovered clip into a project as an asset.
func (s *Server) libraryImport(w http.ResponseWriter, r *http.Request) {
	projID := r.PathValue("id")
	if _, err := s.Store.GetProject(projID); err != nil {
		httpErr(w, 404, err)
		return
	}
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpErr(w, 400, err)
		return
	}
	if !s.Lib.Allowed(body.Path) {
		httpErr(w, 403, fmt.Errorf("path not in an allowed library source"))
		return
	}
	dir, _ := s.Store.AssetsDir(projID)
	assetID := store.NewID("asset_")
	dst := filepath.Join(dir, assetID+filepath.Ext(body.Path))
	if err := copyFile(body.Path, dst); err != nil {
		httpErr(w, 500, err)
		return
	}
	name := body.Name
	if name == "" {
		name = filepath.Base(body.Path)
	}
	asset, err := s.registerAsset(r.Context(), projID, assetID, dst, name, "library")
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	doc, err := s.Store.AddAsset(projID, *asset)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": asset, "version": doc.Version})
}

// ingest is the universal "Send to Studio" target: any product POSTs a finished
// clip here (multipart "file") and it lands in the global inbox, visible in the
// library. Optionally ?projectId=... imports it straight into a project.
func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
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

	inbox := filepath.Join(s.Store.Root(), "inbox")
	if err := os.MkdirAll(inbox, 0o755); err != nil {
		httpErr(w, 500, err)
		return
	}
	src := r.FormValue("source")
	if src == "" {
		src = "external"
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	name := fmt.Sprintf("%s-%s-%s", src, stamp, filepath.Base(header.Filename))
	dst := filepath.Join(inbox, name)
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

	// Optional direct import into a project.
	if projID := r.URL.Query().Get("projectId"); projID != "" {
		if _, err := s.Store.GetProject(projID); err == nil {
			dir, _ := s.Store.AssetsDir(projID)
			assetID := store.NewID("asset_")
			adst := filepath.Join(dir, assetID+filepath.Ext(dst))
			if copyFile(dst, adst) == nil {
				if asset, err := s.registerAsset(r.Context(), projID, assetID, adst, name, src); err == nil {
					s.Store.AddAsset(projID, *asset)
					writeJSON(w, 200, map[string]any{"ok": true, "asset": asset, "inbox": s.Store.Rel(dst)})
					return
				}
			}
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

var _ = context.Background
