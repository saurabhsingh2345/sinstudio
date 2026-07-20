package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

func mustCreate(t *testing.T, s *Store, name string) *schema.EditDoc {
	t.Helper()
	doc, err := s.CreateProject(context.Background(), name)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return doc
}

// TestSaveConflict covers optimistic concurrency: a save based on a revision
// someone else has already superseded must be refused, not silently applied.
func TestSaveConflict(t *testing.T) {
	s := NewTest(t)
	ctx := context.Background()
	doc := mustCreate(t, s, "Conflict")

	rev, err := s.SaveProject(ctx, doc, doc.Version)
	if err != nil {
		t.Fatalf("first save: %v", err)
	}
	if rev != doc.Version+1 {
		t.Fatalf("revision = %d, want %d", rev, doc.Version+1)
	}

	// A second editor still holding the original revision.
	if _, err := s.SaveProject(ctx, doc, doc.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save error = %v, want ErrConflict", err)
	}
	// Re-reading and saving from the current revision succeeds.
	if _, err := s.SaveProject(ctx, doc, rev); err != nil {
		t.Fatalf("save from current revision: %v", err)
	}
}

// TestAssetWritesDoNotConflictWithTimelineEdits is the bug this split exists to
// fix. A finishing export used to append its asset to the whole document; the
// editor's next save then overwrote the document from its own stale copy and the
// export vanished. Assets now live in their own table, so a background write
// neither invalidates the editor's revision nor gets clobbered by its save.
func TestAssetWritesDoNotConflictWithTimelineEdits(t *testing.T) {
	s := NewTest(t)
	ctx := context.Background()
	doc := mustCreate(t, s, "Export race")

	// A background job registers a finished export while the editor holds the doc.
	err := s.AddAsset(ctx, doc.ID, schema.Asset{ID: "asset_export", Name: "Export", Kind: "video"})
	if err != nil {
		t.Fatalf("add asset: %v", err)
	}

	// The editor saves a timeline edit from the revision it loaded. This must NOT
	// conflict — an asset write is not a timeline edit.
	if _, err := s.SaveProject(ctx, doc, doc.Version); err != nil {
		t.Fatalf("editor save after asset write: %v", err)
	}

	// And the export must still be there: the editor's document body never
	// carried the asset set, so it could not have removed it.
	got, err := s.GetProject(ctx, doc.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if len(got.Assets) != 1 || got.Assets[0].ID != "asset_export" {
		t.Fatalf("assets = %+v, want the export to survive the editor's save", got.Assets)
	}
}

// TestDeleteAssetIsSoft confirms a removed asset disappears from the document
// but its media file is left on disk.
func TestDeleteAssetIsSoft(t *testing.T) {
	s := NewTest(t)
	ctx := context.Background()
	doc := mustCreate(t, s, "Delete")

	dir, _ := s.AssetsDir(doc.ID)
	media := filepath.Join(dir, "clip.mp4")
	if err := os.WriteFile(media, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.AddAsset(ctx, doc.ID, schema.Asset{ID: "a1", Path: s.Rel(media)}); err != nil {
		t.Fatalf("add: %v", err)
	}

	if err := s.DeleteAsset(ctx, doc.ID, "a1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got, _ := s.GetProject(ctx, doc.ID)
	if len(got.Assets) != 0 {
		t.Fatalf("assets = %+v, want none after delete", got.Assets)
	}
	if _, err := os.Stat(media); err != nil {
		t.Fatalf("media file should survive a soft delete: %v", err)
	}
	// Deleting again is a 404, not a silent success.
	if err := s.DeleteAsset(ctx, doc.ID, "a1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
}

// TestImportLegacy covers the one-way migration from timeline.json, including
// that re-running it does not duplicate or clobber anything.
func TestImportLegacy(t *testing.T) {
	s := NewTest(t)
	ctx := context.Background()

	legacy := &schema.EditDoc{
		ID:      "proj_legacy",
		Name:    "Old Project",
		Version: 47, // meaningless historically; must not be carried forward
		Canvas:  schema.Canvas{Width: 1280, Height: 720, FPS: 25},
		Tracks:  schema.DefaultTracks(),
		Assets:  []schema.Asset{{ID: "a1", Name: "clip.mp4", Kind: "video"}},
	}
	dir := filepath.Join(s.Root(), "projects", legacy.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(legacy)
	if err := os.WriteFile(filepath.Join(dir, "timeline.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	n, err := s.ImportLegacy(ctx)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if n != 1 {
		t.Fatalf("imported %d, want 1", n)
	}
	got, err := s.GetProject(ctx, legacy.ID)
	if err != nil {
		t.Fatalf("get imported: %v", err)
	}
	if got.Name != "Old Project" || got.Canvas.Width != 1280 {
		t.Fatalf("imported doc = %+v, want name/canvas preserved", got)
	}
	if len(got.Assets) != 1 || got.Assets[0].ID != "a1" {
		t.Fatalf("imported assets = %+v, want the legacy asset", got.Assets)
	}
	if got.Version != 1 {
		t.Fatalf("revision = %d, want 1 (the legacy version is not an ordering)", got.Version)
	}

	// Idempotent: a second run adopts nothing and leaves the file in place.
	if n, err := s.ImportLegacy(ctx); err != nil || n != 0 {
		t.Fatalf("re-import = (%d, %v), want (0, nil)", n, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "timeline.json")); err != nil {
		t.Fatalf("legacy file should be left as a backup: %v", err)
	}
}
