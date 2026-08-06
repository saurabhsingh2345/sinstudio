package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

/*
A render still being written must be invisible and undeletable.

The render history is a list of files with a Download button and a Trash button
on every row, and it is built by prefix. While an export was written under its
final export-* name it appeared there the moment ffmpeg created the file — so
the editor was offered a truncated download of a render still encoding, and a
delete button pointed at a file ffmpeg had open.

Deleting it does not stop the render. The writes carry on into the unlinked
inode and the export fails at the very end, at the faststart pass, which is the
first moment anything opens the file by name again:

	Unable to re-open …/export-….mp4 output file for shifting data
	Error writing trailer: No such file or directory

Both routes in are closed by the working name, and both are checked here.
*/
func TestRenderInProgressIsNotListedOrDeletable(t *testing.T) {
	s := testServer(t, "")
	h := s.Routes()

	w := do(h, "POST", "/api/projects", "", map[string]string{"name": "Demo"})
	if w.Code != 200 {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(w.Body.Bytes(), &created)

	dir, err := s.Store.RendersDir(created.ID)
	if err != nil {
		t.Fatal(err)
	}
	// One export finished, one still encoding — named the way runExport names
	// them, so this breaks if the naming and the prefix ever drift apart.
	done := filepath.Join(dir, "export-aaaa1111.mp4")
	if err := os.WriteFile(done, []byte("finished"), 0o644); err != nil {
		t.Fatal(err)
	}
	working := exportWorkPath(dir, "bbbb2222", "mp4")
	if err := os.WriteFile(working, []byte("half a render"), 0o644); err != nil {
		t.Fatal(err)
	}

	w = do(h, "GET", "/api/projects/"+created.ID+"/renders", "", nil)
	if w.Code != 200 {
		t.Fatalf("list = %d: %s", w.Code, w.Body.String())
	}
	var listed struct {
		Renders []renderEntry `json:"renders"`
	}
	json.Unmarshal(w.Body.Bytes(), &listed)
	if len(listed.Renders) != 1 || listed.Renders[0].Name != "export-aaaa1111.mp4" {
		t.Fatalf("history = %+v, want only the finished export", listed.Renders)
	}

	// And the delete route refuses the working name, so even a client that
	// learned it some other way cannot pull the file out from under ffmpeg.
	w = do(h, "DELETE", "/api/projects/"+created.ID+"/renders/"+filepath.Base(working), "", nil)
	if w.Code != 400 {
		t.Fatalf("delete of a render in progress = %d, want 400", w.Code)
	}
	if _, err := os.Stat(working); err != nil {
		t.Fatalf("the render in progress was removed anyway: %v", err)
	}

	// The finished one still deletes, or the guard has gone too far.
	if w := do(h, "DELETE", "/api/projects/"+created.ID+"/renders/export-aaaa1111.mp4", "", nil); w.Code != 200 {
		t.Fatalf("delete of a finished export = %d, want 200", w.Code)
	}
	if _, err := os.Stat(done); !os.IsNotExist(err) {
		t.Fatalf("finished export survived its delete: %v", err)
	}
}
