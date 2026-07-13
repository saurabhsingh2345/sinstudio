package httpapi

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"studio/internal/schema"
)

// titleDoc is a minimal renderable project (one title clip, no assets needed).
func titleDoc() *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 320, Height: 180, FPS: 24},
		Tracks: []schema.Track{
			{ID: "bg", Kind: schema.TrackBackground, BackgroundColor: "#101020"},
			{ID: "ov", Kind: schema.TrackOverlay, Clips: []schema.Clip{{
				ID: "t1", Start: 0, In: 0, Out: 1,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
				Title:     &schema.Title{Text: "Hi", Size: 48, Color: "#ffffff", PosY: 0.5},
			}}},
		},
	}
}

// createTitleProject makes a project and stores a renderable title timeline.
func createTitleProject(t *testing.T, s *Server) string {
	t.Helper()
	p, err := s.Store.CreateProject("Export Test")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	doc := titleDoc()
	doc.ID = p.ID
	if err := s.Store.SaveProject(doc); err != nil {
		t.Fatalf("save: %v", err)
	}
	return p.ID
}

func TestExportEnqueueValidation(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()
	id := createTitleProject(t, s)

	// An out-of-range export must fail fast at enqueue (compile validation).
	w := do(h, "POST", "/api/projects/"+id+"/export", "", map[string]any{"from": 999})
	if w.Code != 400 {
		t.Fatalf("bad-range export = %d, want 400", w.Code)
	}

	// Retry of an unknown job → 404.
	if w := do(h, "POST", "/api/jobs/nope/retry", "", nil); w.Code != 404 {
		t.Fatalf("retry unknown = %d, want 404", w.Code)
	}
}

func TestExportQueueRuns(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	s := testServer(t, "")
	s.ExportWorkers = 1 // serialize to exercise the queue
	h := s.Routes()
	id := createTitleProject(t, s)

	w := do(h, "POST", "/api/projects/"+id+"/export", "", map[string]any{})
	if w.Code != 202 {
		t.Fatalf("export = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		JobID string `json:"jobId"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.JobID == "" {
		t.Fatal("no jobId returned")
	}

	// Poll the job to completion.
	deadline := time.Now().Add(30 * time.Second)
	var status string
	for time.Now().Before(deadline) {
		jw := do(h, "GET", "/api/jobs/"+resp.JobID, "", nil)
		var j struct {
			Status string `json:"status"`
		}
		json.Unmarshal(jw.Body.Bytes(), &j)
		status = j.Status
		if status == "done" || status == "error" || status == "canceled" {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if status != "done" {
		t.Fatalf("export job ended %q, want done", status)
	}

	// The finished render shows up in the history.
	rw := do(h, "GET", "/api/projects/"+id+"/renders", "", nil)
	var rr struct {
		Renders []struct {
			Name string `json:"name"`
		} `json:"renders"`
	}
	json.Unmarshal(rw.Body.Bytes(), &rr)
	if len(rr.Renders) != 1 {
		t.Fatalf("renders history len = %d, want 1", len(rr.Renders))
	}

	// Retry re-runs it as a new job.
	ret := do(h, "POST", "/api/jobs/"+resp.JobID+"/retry", "", nil)
	if ret.Code != 202 {
		t.Fatalf("retry = %d, want 202", ret.Code)
	}
}

func TestRendersListAndDelete(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()
	id := createTitleProject(t, s)

	dir, _ := s.Store.RendersDir(id)
	// One export file (listed) and one transient frame (excluded).
	os.WriteFile(filepath.Join(dir, "export-abc.mp4"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "frame-xyz.png"), []byte("x"), 0o644)

	w := do(h, "GET", "/api/projects/"+id+"/renders", "", nil)
	var rr struct {
		Renders []struct {
			Name string `json:"name"`
		} `json:"renders"`
	}
	json.Unmarshal(w.Body.Bytes(), &rr)
	if len(rr.Renders) != 1 || rr.Renders[0].Name != "export-abc.mp4" {
		t.Fatalf("renders = %+v, want only export-abc.mp4", rr.Renders)
	}

	// Deleting a non-export name is rejected (can't escape to other files).
	if w := do(h, "DELETE", "/api/projects/"+id+"/renders/frame-xyz.png", "", nil); w.Code == 200 {
		t.Fatal("delete of non-export file should be rejected")
	}
	// Deleting the export works.
	if w := do(h, "DELETE", "/api/projects/"+id+"/renders/export-abc.mp4", "", nil); w.Code != 200 {
		t.Fatalf("delete export = %d, want 200", w.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, "export-abc.mp4")); !os.IsNotExist(err) {
		t.Fatal("export file was not removed")
	}
}
