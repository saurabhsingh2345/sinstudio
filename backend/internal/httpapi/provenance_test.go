package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/generator"
	"studio/internal/schema"
)

// tinyMP4 renders a one-frame video. Ingest probes what it is handed, so these
// tests need real media rather than placeholder bytes.
func tinyMP4(t *testing.T) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	out := filepath.Join(t.TempDir(), "tiny.mp4")
	cmd := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi",
		"-i", "color=c=black:s=64x64:d=0.2:r=10", "-pix_fmt", "yuv420p", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("could not build a test clip: %v (%s)", err, b)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testGens(t *testing.T, s *Server) {
	t.Helper()
	reg, err := generator.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Gens = reg
}

// TestProvenanceSidecarMakesAClipLive is the whole point: a clip authored in a
// plugin's own UI and dropped in a watch folder should arrive re-renderable, not
// as dead media.
func TestProvenanceSidecarMakesAClipLive(t *testing.T) {
	media := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(media, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	doc := `{"scenes":[{"code":"print(1)"}]}`
	sidecar, _ := json.Marshal(Provenance{
		GeneratorID: "funkycode",
		Input:       doc,
		Params:      map[string]string{"--fps": "24"},
	})
	if err := os.WriteFile(provenancePath(media), sidecar, 0o644); err != nil {
		t.Fatal(err)
	}

	s := testServer(t, "")
	testGens(t, s)
	asset := &schema.Asset{ID: "a1", Source: "library"}
	if msg := s.adoptProvenance(asset, media); msg != "" {
		t.Fatalf("adopting a valid sidecar reported: %s", msg)
	}
	if asset.Source != "funkycode" {
		t.Errorf("source = %q, want the generator id so re-render knows what to run", asset.Source)
	}
	if asset.GenInput != doc {
		t.Errorf("genInput = %q, want the document verbatim", asset.GenInput)
	}
	if asset.GenParams["--fps"] != "24" {
		t.Errorf("genParams = %v, want the sidecar's params", asset.GenParams)
	}
}

// TestProvenanceIsOptional — most files have no sidecar and must import exactly
// as before.
func TestProvenanceIsOptional(t *testing.T) {
	media := filepath.Join(t.TempDir(), "plain.mp4")
	os.WriteFile(media, []byte("x"), 0o644)

	s := testServer(t, "")
	testGens(t, s)
	asset := &schema.Asset{ID: "a1", Source: "library"}
	if msg := s.adoptProvenance(asset, media); msg != "" {
		t.Fatalf("a missing sidecar is normal, got: %s", msg)
	}
	if asset.Source != "library" || asset.GenInput != "" {
		t.Fatalf("asset should be untouched, got %+v", asset)
	}
}

// TestBadProvenanceIsReportedNotFatal — a malformed or unknown-generator sidecar
// must not cost you the clip. The media is the valuable part; losing it because
// its metadata was wrong would be a worse trade than losing editability.
func TestBadProvenanceIsReportedNotFatal(t *testing.T) {
	s := testServer(t, "")
	testGens(t, s)

	cases := []struct {
		name, body string
	}{
		{"malformed.mp4", `{ not json`},
		{"nogen.mp4", `{"input":"x"}`},
		{"unknown.mp4", `{"generatorId":"nope","input":"x"}`},
	}
	for _, c := range cases {
		dir := t.TempDir()
		media := filepath.Join(dir, c.name)
		os.WriteFile(media, []byte("x"), 0o644)
		os.WriteFile(provenancePath(media), []byte(c.body), 0o644)

		asset := &schema.Asset{ID: "a1", Source: "library"}
		msg := s.adoptProvenance(asset, media)
		if msg == "" {
			t.Errorf("%s: expected a reported reason", c.name)
		}
		// The asset is still importable, just not live.
		if asset.Source != "library" || asset.GenInput != "" {
			t.Errorf("%s: asset should be left as plain media, got %+v", c.name, asset)
		}
	}
}

// TestIngestAcceptsProvenance covers the "Send to Studio" path: a plugin POSTs
// its render together with the document that produced it, and gets a live clip.
func TestIngestAcceptsProvenance(t *testing.T) {
	s := testServer(t, "")
	testGens(t, s)
	h := s.Routes()
	projID := createTitleProject(t, s)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "out.mp4")
	fw.Write(tinyMP4(t))
	mw.WriteField("source", "funkycode")
	mw.WriteField("studio", `{"generatorId":"funkycode","input":"{\"scenes\":[]}","params":{"--fps":"30"}}`)
	mw.Close()

	r := httptest.NewRequest("POST", "/api/ingest?projectId="+projID, &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("ingest = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Asset           *schema.Asset `json:"asset"`
		ProvenanceError string        `json:"provenanceError"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.ProvenanceError != "" {
		t.Fatalf("provenance rejected: %s", resp.ProvenanceError)
	}
	if resp.Asset == nil || resp.Asset.Source != "funkycode" || resp.Asset.GenInput == "" {
		t.Fatalf("ingested asset is not live: %+v", resp.Asset)
	}

	// The clip is live in the project as stored, not just in the response.
	doc, err := s.Store.GetProject(context.Background(), projID)
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Assets) != 1 || doc.Assets[0].GenInput == "" {
		t.Fatalf("stored asset lost its provenance: %+v", doc.Assets)
	}
}

// TestIngestReportsBadProvenance — the clip still lands, the reason is returned.
func TestIngestReportsBadProvenance(t *testing.T) {
	s := testServer(t, "")
	testGens(t, s)
	h := s.Routes()
	projID := createTitleProject(t, s)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "out.mp4")
	fw.Write(tinyMP4(t))
	mw.WriteField("studio", `{"generatorId":"does-not-exist","input":"x"}`)
	mw.Close()

	r := httptest.NewRequest("POST", "/api/ingest?projectId="+projID, &buf)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ingest = %d, want the clip to land anyway: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Asset           *schema.Asset `json:"asset"`
		ProvenanceError string        `json:"provenanceError"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.ProvenanceError == "" {
		t.Error("expected a reported reason for the rejected provenance")
	}
	if resp.Asset == nil {
		t.Fatal("the clip should still import as plain media")
	}
	if resp.Asset.GenInput != "" {
		t.Error("asset should not claim to be re-renderable by an unknown generator")
	}
}
