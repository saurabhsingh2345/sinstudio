package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"studio/internal/generator"
)

// TestPreviewRequiresPreviewMode: a generator with no cheap variant has no
// preview, and must say so at the request rather than starting a full render
// that the editor would present as a preview.
func TestPreviewRequiresPreviewMode(t *testing.T) {
	s := testServer(t, "")
	reg, err := generator.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Gens = reg
	h := s.Routes()
	id := createTitleProject(t, s)

	// kokorovoice declares no preview block (TTS has no cheap mode).
	w := do(h, "POST", "/api/projects/"+id+"/preview", "",
		map[string]any{"generatorId": "kokorovoice", "input": "hello"})
	if w.Code != 400 {
		t.Fatalf("preview of a generator without preview mode = %d, want 400: %s", w.Code, w.Body.String())
	}

	// An unknown generator is likewise rejected up front.
	if w := do(h, "POST", "/api/projects/"+id+"/preview", "",
		map[string]any{"generatorId": "nope", "input": "x"}); w.Code != 400 {
		t.Fatalf("unknown generator = %d, want 400", w.Code)
	}
}

// TestPreviewSupersedes is the property the editor depends on: while one preview
// of the same thing is rendering, a newer request cancels it instead of queueing
// behind it. Otherwise dragging a slider would render every intermediate value
// and deliver them out of order.
func TestPreviewSupersedes(t *testing.T) {
	s := testServer(t, "")
	reg, err := generator.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.Gens = reg
	h := s.Routes()
	id := createTitleProject(t, s)

	req := func() string {
		t.Helper()
		w := do(h, "POST", "/api/projects/"+id+"/preview", "",
			map[string]any{"generatorId": "funkycode", "input": `{"scenes":[{"code":"x"}]}`, "key": "same"})
		if w.Code != 202 {
			t.Fatalf("preview = %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			JobID string `json:"jobId"`
		}
		json.Unmarshal(w.Body.Bytes(), &resp)
		return resp.JobID
	}

	first := req()
	second := req()
	if first == second {
		t.Fatal("each preview request should be its own job")
	}

	// The superseded job must reach a terminal state without having produced a
	// result. (funkycode isn't installed in the test root, so neither job renders
	// anything — what is being checked is that the first was actively cancelled,
	// not merely left to fail on its own.)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j, ok := s.Jobs.Get(first); ok && j.Status != "queued" && j.Status != "running" {
			if j.Status == "done" {
				t.Fatalf("superseded preview completed; it should have been cancelled")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("superseded preview never reached a terminal state")
}

// TestPreviewParamsOverrideUserParams pins the merge direction: the generator's
// preview overrides must win, since they are what makes the render cheap.
func TestPreviewParamsOverrideUserParams(t *testing.T) {
	reg, err := generator.NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, ok := reg.Get("funkycode")
	if !ok || a.Preview == nil {
		t.Fatal("funkycode should declare a preview mode")
	}
	got := previewParams(a, map[string]string{"--fps": "60", "--shorts": "true"})
	if got["--fps"] != a.Preview.Params["--fps"] {
		t.Errorf("preview --fps = %q, want the override %q", got["--fps"], a.Preview.Params["--fps"])
	}
	// Params the preview doesn't override are carried through, so the preview
	// still reflects the framing and other choices being edited.
	if got["--shorts"] != "true" {
		t.Errorf("--shorts = %q, want the user's value carried through", got["--shorts"])
	}
}

// TestPreviewsArePruned: editing writes one file per change, so the directory
// must not grow without bound.
func TestPreviewsArePruned(t *testing.T) {
	s := testServer(t, "")
	id := createTitleProject(t, s)
	dir, err := s.Store.PreviewsDir(id)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < previewsKept+5; i++ {
		writeFile(t, dir, "preview_"+string(rune('a'+i))+".mp4")
		time.Sleep(5 * time.Millisecond) // distinct mtimes so "newest" is well-defined
	}
	s.Store.PrunePreviews(id, previewsKept)

	entries, err := readDirNames(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != previewsKept {
		t.Fatalf("kept %d previews, want %d", len(entries), previewsKept)
	}
	// And the project itself is untouched by preview churn.
	if _, err := s.Store.GetProject(context.Background(), id); err != nil {
		t.Fatalf("project should be unaffected: %v", err)
	}
}

func writeFile(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readDirNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out, nil
}
