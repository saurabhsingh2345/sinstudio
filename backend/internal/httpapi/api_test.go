package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"studio/internal/jobs"
	"studio/internal/store"
)

func testServer(t *testing.T, token string) *Server {
	t.Helper()
	return &Server{Store: store.NewTest(t), Jobs: jobs.NewManager(), Auth: NewAuth(token)}
}

func do(h http.Handler, method, path, cookie string, body any) *httptest.ResponseRecorder {
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	if cookie != "" {
		r.Header.Set("Cookie", cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHealthOpen(t *testing.T) {
	h := testServer(t, "").Routes()
	if w := do(h, "GET", "/health", "", nil); w.Code != 200 {
		t.Fatalf("health = %d, want 200", w.Code)
	}
}

func TestProjectCRUD(t *testing.T) {
	h := testServer(t, "").Routes()

	w := do(h, "POST", "/api/projects", "", map[string]string{"name": "Demo"})
	if w.Code != 200 {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var created struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.ID == "" || created.Name != "Demo" {
		t.Fatalf("bad created project: %+v", created)
	}

	if w := do(h, "GET", "/api/projects/"+created.ID, "", nil); w.Code != 200 {
		t.Fatalf("get = %d", w.Code)
	}
	if w := do(h, "GET", "/api/projects/nope", "", nil); w.Code != 404 {
		t.Fatalf("get missing = %d, want 404", w.Code)
	}

	w = do(h, "GET", "/api/projects", "", nil)
	var list []map[string]any
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}
}

func TestMarkersRoundTrip(t *testing.T) {
	h := testServer(t, "").Routes()

	w := do(h, "POST", "/api/projects", "", map[string]string{"name": "Markers"})
	if w.Code != 200 {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var created map[string]any
	json.Unmarshal(w.Body.Bytes(), &created)
	id, _ := created["id"].(string)
	version, _ := created["version"].(float64)
	if id == "" {
		t.Fatal("missing project id")
	}

	created["markers"] = []map[string]any{
		{"id": "mk_1", "t": 1.5, "label": "Intro", "color": "#22c55e"},
		{"id": "mk_2", "t": 5.0, "label": "Chapter", "color": "#3b82f6"},
	}
	created["version"] = version

	w = do(h, "PUT", "/api/projects/"+id, "", created)
	if w.Code != 200 {
		t.Fatalf("save = %d: %s", w.Code, w.Body.String())
	}

	w = do(h, "GET", "/api/projects/"+id, "", nil)
	if w.Code != 200 {
		t.Fatalf("get = %d", w.Code)
	}
	var loaded map[string]any
	json.Unmarshal(w.Body.Bytes(), &loaded)
	markers, ok := loaded["markers"].([]any)
	if !ok || len(markers) != 2 {
		t.Fatalf("markers round-trip = %+v", loaded["markers"])
	}
	m0, _ := markers[0].(map[string]any)
	if m0["label"] != "Intro" {
		t.Fatalf("marker label = %v", m0["label"])
	}
}

func TestAuthGate(t *testing.T) {
	h := testServer(t, "s3cret").Routes()

	// Protected route without auth → 401.
	if w := do(h, "GET", "/api/projects", "", nil); w.Code != 401 {
		t.Fatalf("unauthed protected = %d, want 401", w.Code)
	}
	// Open routes stay reachable.
	if w := do(h, "GET", "/health", "", nil); w.Code != 200 {
		t.Fatalf("health under auth = %d, want 200", w.Code)
	}
	// Wrong token → 401.
	if w := do(h, "POST", "/api/login", "", map[string]string{"token": "nope"}); w.Code != 401 {
		t.Fatalf("bad login = %d, want 401", w.Code)
	}
	// Correct token → sets a session cookie.
	w := do(h, "POST", "/api/login", "", map[string]string{"token": "s3cret"})
	if w.Code != 200 {
		t.Fatalf("login = %d", w.Code)
	}
	setCookie := w.Result().Header.Get("Set-Cookie")
	if !strings.HasPrefix(setCookie, sessionCookie+"=") {
		t.Fatalf("no session cookie set: %q", setCookie)
	}
	cookie, _, _ := strings.Cut(setCookie, ";")

	// Cookie now grants access.
	if w := do(h, "GET", "/api/projects", cookie, nil); w.Code != 200 {
		t.Fatalf("authed via cookie = %d, want 200", w.Code)
	}

	// Bearer token also grants access.
	r := httptest.NewRequest("GET", "/api/projects", nil)
	r.Header.Set("Authorization", "Bearer s3cret")
	bw := httptest.NewRecorder()
	h.ServeHTTP(bw, r)
	if bw.Code != 200 {
		t.Fatalf("authed via bearer = %d, want 200", bw.Code)
	}

	// authState reflects requirement + satisfaction.
	as := do(h, "GET", "/api/auth", cookie, nil)
	var st struct{ Required, Authed bool }
	json.Unmarshal(as.Body.Bytes(), &st)
	if !st.Required || !st.Authed {
		t.Fatalf("authState = %+v, want required+authed", st)
	}
}

func TestJobEndpoints(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()
	j := s.Jobs.New("export", 0)

	w := do(h, "GET", "/api/jobs/"+j.ID, "", nil)
	if w.Code != 200 {
		t.Fatalf("get job = %d", w.Code)
	}
	if w := do(h, "GET", "/api/jobs/missing", "", nil); w.Code != 404 {
		t.Fatalf("missing job = %d, want 404", w.Code)
	}

	if w := do(h, "POST", "/api/jobs/"+j.ID+"/cancel", "", nil); w.Code != 200 {
		t.Fatalf("cancel = %d", w.Code)
	}
	select {
	case <-j.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("cancel did not fire job context")
	}
}
