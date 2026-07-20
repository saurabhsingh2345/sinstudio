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

// sanitizeToken reduces a caller-supplied label (e.g. the ingest "source") to a
// safe filename fragment: only [A-Za-z0-9._-], capped in length. This prevents a
// crafted value like "../../etc" from escaping the target directory once it is
// joined into a path.
func sanitizeToken(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			out = append(out, r)
		default:
			out = append(out, '-')
		}
		if len(out) >= 40 {
			break
		}
	}
	return string(out)
}

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
	if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
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
	if err := waitForStable(r.Context(), body.Path); err != nil {
		httpErr(w, 500, err)
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
		os.Remove(dst)
		httpErr(w, 500, err)
		return
	}
	err = s.Store.AddAsset(r.Context(), projID, *asset)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": asset})
}

// ingest is the universal "Send to Studio" target: any product POSTs a finished
// clip here (multipart "file") and it lands in the global inbox, visible in the
// library. Optionally ?projectId=... imports it straight into a project.
func (s *Server) ingest(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
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
	src := sanitizeToken(r.FormValue("source"))
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

	// Optional direct import into a project. The clip is already safe in the
	// inbox, so an import failure is reported alongside the inbox location
	// rather than silently swallowed.
	if projID := r.URL.Query().Get("projectId"); projID != "" {
		if _, err := s.Store.GetProject(r.Context(), projID); err != nil {
			httpErr(w, 404, fmt.Errorf("project %s: %w", projID, err))
			return
		}
		dir, _ := s.Store.AssetsDir(projID)
		assetID := store.NewID("asset_")
		adst := filepath.Join(dir, assetID+filepath.Ext(dst))
		if err := copyFile(dst, adst); err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name, "importError": err.Error()})
			return
		}
		asset, err := s.registerAsset(r.Context(), projID, assetID, adst, name, src)
		if err != nil {
			os.Remove(adst)
			writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name, "importError": err.Error()})
			return
		}
		if err := s.Store.AddAsset(r.Context(), projID, *asset); err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name, "importError": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "asset": asset, "inbox": s.Store.Rel(dst)})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name})
}

// waitForStable blocks until path looks fully written: its mtime is not
// fresh and its size has stopped changing. Auto-import can race an ffmpeg
// render that is still writing the file; importing mid-write yields a
// truncated asset that probes silent (or fails outright). Old files return
// immediately; a writer still going at the deadline is an error rather than
// a truncated import.
func waitForStable(ctx context.Context, path string) error {
	deadline := time.Now().Add(15 * time.Second)
	var lastSize int64 = -1
	for {
		fi, err := os.Stat(path)
		if err != nil {
			return err
		}
		settled := time.Since(fi.ModTime()) >= 1200*time.Millisecond
		if settled && fi.Size() > 0 && (lastSize == -1 || fi.Size() == lastSize) {
			return nil
		}
		lastSize = fi.Size()
		if time.Now().After(deadline) {
			return fmt.Errorf("%s is still being written — import it once the render finishes", filepath.Base(path))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(400 * time.Millisecond):
		}
	}
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
