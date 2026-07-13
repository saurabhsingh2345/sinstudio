package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
)

// Auth is an optional shared-token gate. When Token is empty the server is open
// (the default, for localhost development). When Token is set, browser clients
// authenticate once via POST /api/login (which mints a random session cookie),
// and programmatic clients may instead send `Authorization: Bearer <token>`.
//
// The session cookie carries a random id — never the master token — so a leaked
// cookie can be revoked (logout / restart) without rotating the token.
type Auth struct {
	Token    string
	mu       sync.Mutex
	sessions map[string]struct{}
}

// NewAuth builds an Auth gate for the given token ("" = open).
func NewAuth(token string) *Auth {
	return &Auth{Token: strings.TrimSpace(token), sessions: map[string]struct{}{}}
}

// Enabled reports whether a token is configured.
func (a *Auth) Enabled() bool { return a != nil && a.Token != "" }

// tokenOK compares a candidate token to the configured one in constant time.
func (a *Auth) tokenOK(candidate string) bool {
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(a.Token)) == 1
}

func (a *Auth) newSession() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	a.mu.Lock()
	a.sessions[id] = struct{}{}
	a.mu.Unlock()
	return id
}

func (a *Auth) validSession(id string) bool {
	if id == "" {
		return false
	}
	a.mu.Lock()
	_, ok := a.sessions[id]
	a.mu.Unlock()
	return ok
}

func (a *Auth) dropSession(id string) {
	a.mu.Lock()
	delete(a.sessions, id)
	a.mu.Unlock()
}

const sessionCookie = "studio_session"

// authed reports whether a request carries a valid session cookie or bearer token.
func (a *Auth) authed(r *http.Request) bool {
	if !a.Enabled() {
		return true
	}
	if c, err := r.Cookie(sessionCookie); err == nil && a.validSession(c.Value) {
		return true
	}
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return a.tokenOK(strings.TrimPrefix(h, "Bearer "))
	}
	return false
}

// Middleware guards protected paths. Open paths (health, the login endpoints,
// and the SPA/static shell so the login screen can load) always pass; everything
// under /api and /media requires authentication when a token is configured.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.Enabled() || isOpenPath(r.URL.Path) || a.authed(r) {
			next.ServeHTTP(w, r)
			return
		}
		writeJSON(w, 401, map[string]any{"error": "authentication required"})
	})
}

// isOpenPath lists routes reachable without authentication.
func isOpenPath(p string) bool {
	switch {
	case p == "/health", p == "/api/login", p == "/api/logout", p == "/api/auth":
		return true
	case strings.HasPrefix(p, "/api/"), strings.HasPrefix(p, "/media/"):
		return false
	default:
		// SPA shell + static assets so the login page can load.
		return true
	}
}

// login validates the posted token and, on success, sets a session cookie.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.Auth.Enabled() {
		writeJSON(w, 200, map[string]any{"ok": true, "required": false})
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !s.Auth.tokenOK(strings.TrimSpace(body.Token)) {
		writeJSON(w, 401, map[string]any{"error": "invalid token"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    s.Auth.newSession(),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// logout invalidates the caller's session cookie.
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.Auth.dropSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// authState tells the SPA whether auth is required and whether it's satisfied.
func (s *Server) authState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"required": s.Auth.Enabled(), "authed": s.Auth.authed(r)})
}
