package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"studio/internal/cursor"
	"studio/internal/media"
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

// truthy reads a form flag written by whatever client happens to be posting —
// browsers send "1"/"true"/"on" depending on how the field was built.
func truthy(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
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
	// A plugin that wrote a sidecar next to its render gets a live clip rather
	// than dead media — this is the path clips authored in a plugin's own UI
	// arrive by. Read it from the ORIGINAL location: the sidecar sits beside the
	// file the plugin wrote, not beside our copy.
	provErr := s.adoptProvenance(asset, body.Path)
	if err := s.Store.AddAsset(r.Context(), projID, *asset); err != nil {
		httpErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"asset": asset, "provenanceError": provErr})
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
	// Optional provenance, so a clip posted by a plugin stays editable. Parsed
	// before anything is written so a malformed one is reported, not silently
	// dropped — but it never blocks the upload: the media is the valuable part.
	var (
		prov    *Provenance
		provErr string
	)
	if raw := strings.TrimSpace(r.FormValue("studio")); raw != "" {
		var p Provenance
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			provErr = "studio field: " + err.Error()
		} else if p.GeneratorID == "" {
			provErr = "studio field: missing generatorId"
		} else {
			prov = &p
		}
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

	// Repair a streamed container before anything probes or plays it. A browser
	// recording arrives with no duration and no seek index; leaving it that way
	// gives a clip the timeline can't measure and the preview can't scrub.
	//
	// The uploader declares this with "streamed", because which containers a
	// MediaRecorder can emit is a moving target — inferring it from the
	// extension would quietly stop covering the case the day a browser starts
	// producing something else. The extension check stays as a backstop for
	// uploaders that don't say (WebM here is a recording in all but name).
	//
	// Best-effort by design: a file we failed to repair is still a usable clip,
	// so the error is reported alongside the asset rather than failing the upload.
	var remuxErr string
	if truthy(r.FormValue("streamed")) || media.NeedsRemux(dst) {
		if err := media.RemuxInPlace(r.Context(), dst); err != nil {
			remuxErr = err.Error()
		}
	}

	// Keep the provenance next to the inbox copy too, so importing this clip
	// from the library later is just as live as importing it now.
	if prov != nil {
		if data, err := json.Marshal(prov); err == nil {
			_ = os.WriteFile(provenancePath(dst), data, 0o644)
		}
	}

	// Cursor data for a screen recording, written beside the media the same way.
	// Non-fatal for the same reason as provenance: the recording is the valuable
	// part, and losing it because its metadata was malformed is the worse trade.
	var cursorErr string
	if raw := strings.TrimSpace(r.FormValue("cursor")); raw != "" {
		track, err := cursor.Parse(raw)
		if err != nil {
			cursorErr = err.Error()
		} else if err := cursor.Write(dst, track); err != nil {
			cursorErr = err.Error()
		}
	}

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
		// The cursor sidecar has to travel with the media, or the project's copy
		// of a screen recording arrives without the data its effects need.
		if err := copyFile(cursor.Path(dst), cursor.Path(adst)); err != nil && !os.IsNotExist(err) {
			cursorErr = err.Error()
		}
		asset, err := s.registerAsset(r.Context(), projID, assetID, adst, name, src)
		if err != nil {
			os.Remove(adst)
			writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name, "importError": err.Error()})
			return
		}
		if prov != nil {
			if err := s.applyProvenance(asset, prov); err != nil {
				provErr = err.Error()
			}
		}
		if err := s.Store.AddAsset(r.Context(), projID, *asset); err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "inbox": s.Store.Rel(dst), "name": name, "importError": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "asset": asset, "inbox": s.Store.Rel(dst),
			"provenanceError": provErr, "remuxError": remuxErr, "cursorError": cursorErr,
		})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "inbox": s.Store.Rel(dst), "name": name,
		"remuxError": remuxErr, "cursorError": cursorErr,
	})
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
