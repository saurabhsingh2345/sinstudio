package httpapi

import (
	"errors"
	"net/http"

	"studio/internal/cursor"
)

// cursorTrack serves the pointer track recorded beside an asset.
//
// The editor needs it to derive auto-zoom keyframes from where the user was
// actually working. That derivation lives in the browser deliberately: it
// produces ordinary keyframes on the document, so the result is undoable,
// visible on the timeline, and editable key by key — the same contract as the
// motion presets. A server-side "apply focus" would produce motion nobody
// could adjust afterwards.
func (s *Server) cursorTrack(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.GetProject(r.Context(), r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	assetID := r.URL.Query().Get("asset")
	var path string
	for _, a := range doc.Assets {
		if a.ID == assetID {
			path = s.Store.Abs(a.Path)
			break
		}
	}
	if path == "" {
		httpErr(w, 404, errors.New("asset not found"))
		return
	}
	track, err := cursor.Read(path)
	if err != nil {
		httpErr(w, 500, err)
		return
	}
	if track == nil {
		// Not an error: most clips simply aren't screen recordings.
		writeJSON(w, 200, map[string]any{"track": nil})
		return
	}
	writeJSON(w, 200, map[string]any{"track": track})
}
