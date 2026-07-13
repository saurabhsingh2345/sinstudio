package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

// postFile issues a multipart upload of one file field.
func postFile(h http.Handler, path, field, filename string, content []byte) *httptest.ResponseRecorder {
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile(field, filename)
	fw.Write(content)
	mw.Close()
	r := httptest.NewRequest("POST", path, &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestLUTUploadListDelete(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()
	id := createTitleProject(t, s)

	cube := []byte("LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n")

	// A non-.cube upload is rejected.
	if w := postFile(h, "/api/projects/"+id+"/luts", "file", "notalut.txt", cube); w.Code != 400 {
		t.Fatalf("non-cube upload = %d, want 400", w.Code)
	}

	// A .cube uploads and is listed.
	w := postFile(h, "/api/projects/"+id+"/luts", "file", "My Look.cube", cube)
	if w.Code != 200 {
		t.Fatalf("upload = %d: %s", w.Code, w.Body.String())
	}
	var up struct {
		Name string `json:"name"`
	}
	json.Unmarshal(w.Body.Bytes(), &up)
	if up.Name == "" {
		t.Fatal("no name returned")
	}

	lw := do(h, "GET", "/api/projects/"+id+"/luts", "", nil)
	var ll struct {
		Luts []string `json:"luts"`
	}
	json.Unmarshal(lw.Body.Bytes(), &ll)
	if len(ll.Luts) != 1 || ll.Luts[0] != up.Name {
		t.Fatalf("luts = %v, want [%s]", ll.Luts, up.Name)
	}

	// Delete it.
	if w := do(h, "DELETE", "/api/projects/"+id+"/luts/"+up.Name, "", nil); w.Code != 200 {
		t.Fatalf("delete = %d", w.Code)
	}
	lw = do(h, "GET", "/api/projects/"+id+"/luts", "", nil)
	json.Unmarshal(lw.Body.Bytes(), &ll)
	if len(ll.Luts) != 0 {
		t.Fatalf("after delete luts = %v, want empty", ll.Luts)
	}
}
