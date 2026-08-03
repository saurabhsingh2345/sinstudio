package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"studio/internal/jobs"
	"studio/internal/schema"
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

// TestRenameAssetRoute covers renaming a media item from the editor's media
// panel. Assets are excluded from a document save, so this endpoint is the only
// thing that makes the new label survive a reload.
func TestRenameAssetRoute(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()

	w := do(h, "POST", "/api/projects", "", map[string]string{"name": "Proj"})
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)

	asset := schema.Asset{ID: "a1", Name: "recording-screen-2026.mp4", Kind: "video", Path: "x.mp4"}
	if err := s.Store.AddAsset(context.Background(), created.ID, asset); err != nil {
		t.Fatal(err)
	}

	base := "/api/projects/" + created.ID + "/assets/"
	w = do(h, "PATCH", base+"a1", "", map[string]string{"name": "Checkout flow"})
	if w.Code != 200 {
		t.Fatalf("rename = %d: %s", w.Code, w.Body.String())
	}
	var got struct {
		Asset schema.Asset `json:"asset"`
	}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got.Asset.Label != "Checkout flow" {
		t.Fatalf("rename returned %+v", got.Asset)
	}

	w = do(h, "GET", "/api/projects/"+created.ID, "", nil)
	var doc schema.EditDoc
	json.Unmarshal(w.Body.Bytes(), &doc)
	if len(doc.Assets) != 1 || doc.Assets[0].Label != "Checkout flow" {
		t.Fatalf("reloaded assets = %+v", doc.Assets)
	}
	// The file is still called what it is called.
	if doc.Assets[0].Name != "recording-screen-2026.mp4" {
		t.Fatalf("rename overwrote the filename: %q", doc.Assets[0].Name)
	}

	if w := do(h, "PATCH", base+"a1", "", map[string]string{"name": "  "}); w.Code != 400 {
		t.Fatalf("blank rename = %d, want 400", w.Code)
	}
	if w := do(h, "PATCH", base+"nope", "", map[string]string{"name": "x"}); w.Code != 404 {
		t.Fatalf("rename missing asset = %d, want 404", w.Code)
	}
}

// TestProjectManageRoutes covers the project-list actions: rename in place,
// duplicate into a second project, and delete.
func TestProjectManageRoutes(t *testing.T) {
	h := testServer(t, "").Routes()

	w := do(h, "POST", "/api/projects", "", map[string]string{"name": "First"})
	if w.Code != 200 {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)

	w = do(h, "PATCH", "/api/projects/"+created.ID, "", map[string]string{"name": "Renamed"})
	if w.Code != 200 {
		t.Fatalf("rename = %d: %s", w.Code, w.Body.String())
	}
	var meta struct {
		Name string `json:"name"`
	}
	json.Unmarshal(w.Body.Bytes(), &meta)
	if meta.Name != "Renamed" {
		t.Fatalf("rename returned %q", meta.Name)
	}
	if w := do(h, "PATCH", "/api/projects/"+created.ID, "", map[string]string{"name": " "}); w.Code != 400 {
		t.Fatalf("blank rename = %d, want 400", w.Code)
	}
	if w := do(h, "PATCH", "/api/projects/nope", "", map[string]string{"name": "x"}); w.Code != 404 {
		t.Fatalf("rename missing = %d, want 404", w.Code)
	}

	w = do(h, "POST", "/api/projects/"+created.ID+"/duplicate", "", map[string]string{})
	if w.Code != 200 {
		t.Fatalf("duplicate = %d: %s", w.Code, w.Body.String())
	}
	var dup struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	json.Unmarshal(w.Body.Bytes(), &dup)
	if dup.ID == created.ID || dup.Name != "Renamed copy" {
		t.Fatalf("bad duplicate: %+v", dup)
	}

	w = do(h, "GET", "/api/projects", "", nil)
	var list []map[string]any
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 2 {
		t.Fatalf("list len = %d, want 2", len(list))
	}

	if w := do(h, "DELETE", "/api/projects/"+created.ID, "", nil); w.Code != 200 {
		t.Fatalf("delete = %d: %s", w.Code, w.Body.String())
	}
	if w := do(h, "GET", "/api/projects/"+created.ID, "", nil); w.Code != 404 {
		t.Fatalf("get after delete = %d, want 404", w.Code)
	}
	if w := do(h, "DELETE", "/api/projects/"+created.ID, "", nil); w.Code != 404 {
		t.Fatalf("second delete = %d, want 404", w.Code)
	}
	// The copy is untouched by the original's deletion.
	if w := do(h, "GET", "/api/projects/"+dup.ID, "", nil); w.Code != 200 {
		t.Fatalf("copy after deleting source = %d", w.Code)
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
