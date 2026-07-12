package httpapi

import "net/http"

// listApps returns live status for every supervised sibling app.
func (s *Server) listApps(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Apps.List())
}

func (s *Server) startApp(w http.ResponseWriter, r *http.Request) {
	if err := s.Apps.Start(r.PathValue("id")); err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) stopApp(w http.ResponseWriter, r *http.Request) {
	if err := s.Apps.Stop(r.PathValue("id")); err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) restartApp(w http.ResponseWriter, r *http.Request) {
	if err := s.Apps.Restart(r.PathValue("id")); err != nil {
		httpErr(w, 400, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) appLogs(w http.ResponseWriter, r *http.Request) {
	lines, err := s.Apps.Logs(r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	writeJSON(w, 200, map[string]any{"lines": lines})
}
