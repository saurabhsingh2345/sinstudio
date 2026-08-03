package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

// seedProject builds a local project with one asset, one clip referencing it,
// and a real file plus thumbnail on disk — the shape duplicate and delete have
// to get right.
func seedProject(t *testing.T, s *Store, name string) *schema.EditDoc {
	t.Helper()
	ctx := context.Background()

	doc, err := s.CreateProject(ctx, name)
	if err != nil {
		t.Fatal(err)
	}
	assets, err := s.AssetsDir(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	thumbs, err := s.ThumbsDir(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	media := filepath.Join(assets, "clip.mp4")
	thumb := filepath.Join(thumbs, "clip.png")
	if err := os.WriteFile(media, []byte("video bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(thumb, []byte("thumb bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	asset := schema.Asset{
		ID: "asset_seed", Name: "clip.mp4", Kind: "video",
		Path: s.Rel(media), Thumbnail: s.Rel(thumb),
	}
	if err := s.AddAsset(ctx, doc.ID, asset); err != nil {
		t.Fatal(err)
	}
	doc.Tracks[1].Clips = []schema.Clip{{ID: "c1", AssetID: asset.ID, Out: 1, Volume: 1}}
	if _, err := s.SaveProject(ctx, doc, doc.Version); err != nil {
		t.Fatal(err)
	}
	out, err := s.GetProject(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func localStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestRenameProject(t *testing.T) {
	s := localStore(t)
	ctx := context.Background()
	doc := seedProject(t, s, "Before")

	meta, err := s.RenameProject(ctx, doc.ID, "  After  ")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "After" {
		t.Fatalf("name=%q, want trimmed %q", meta.Name, "After")
	}

	got, err := s.GetProject(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "After" {
		t.Fatalf("persisted name=%q", got.Name)
	}
	// The revision has to move, or an editor holding the project open would
	// autosave the old name straight back over the rename.
	if got.Version <= doc.Version {
		t.Fatalf("revision=%d, want > %d", got.Version, doc.Version)
	}
	if _, err := s.SaveProject(ctx, doc, doc.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale save err=%v, want ErrConflict", err)
	}

	if _, err := s.RenameProject(ctx, doc.ID, "   "); err == nil {
		t.Fatal("empty name accepted")
	}
	if _, err := s.RenameProject(ctx, "proj_missing", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rename missing err=%v, want ErrNotFound", err)
	}
}

/*
TestRenameAsset runs the same assertions against both backends, because
RenameAsset is two separate implementations — a JSONB update and a read-modify-
write of timeline.json — and a divergence between them is invisible until
someone switches STUDIO_DATABASE_URL.
*/
func TestRenameAsset(t *testing.T) {
	for _, tc := range []struct {
		name string
		open func(*testing.T) *Store
	}{
		{"local", localStore},
		{"postgres", NewTest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := tc.open(t)
			ctx := context.Background()
			doc := seedProject(t, s, "Proj")
			before := doc.Version

			got, err := s.RenameAsset(ctx, doc.ID, "asset_seed", "  Checkout flow  ")
			if err != nil {
				t.Fatal(err)
			}
			if got.Label != "Checkout flow" {
				t.Fatalf("label=%q, want trimmed", got.Label)
			}
			// Everything else on the row belongs to whatever probed or generated
			// it; a rename that dropped the path would orphan the media, and one
			// that overwrote the name would lose what the file is really called.
			if got.Name != "clip.mp4" || got.Path != doc.Assets[0].Path || got.Kind != "video" {
				t.Fatalf("rename disturbed the rest of the asset: %+v", got)
			}

			fresh, err := s.GetProject(ctx, doc.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(fresh.Assets) != 1 || fresh.Assets[0].Label != "Checkout flow" {
				t.Fatalf("persisted assets=%+v", fresh.Assets)
			}
			// Unlike a project rename this must NOT bump the revision: an asset
			// write is not a timeline edit, and conflicting with the editor's own
			// autosave on every keystroke is the bug that split the tables.
			if fresh.Version != before {
				t.Fatalf("revision moved %d → %d; an asset rename is not a timeline edit", before, fresh.Version)
			}

			if _, err := s.RenameAsset(ctx, doc.ID, "asset_seed", "   "); err == nil {
				t.Fatal("empty name accepted")
			}
			if _, err := s.RenameAsset(ctx, doc.ID, "nope", "x"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("unknown asset err=%v, want ErrNotFound", err)
			}
		})
	}
}

func TestDuplicateProject(t *testing.T) {
	s := localStore(t)
	ctx := context.Background()
	src := seedProject(t, s, "Original")

	dup, err := s.DuplicateProject(ctx, src.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if dup.ID == src.ID {
		t.Fatal("duplicate reused the source id")
	}
	if dup.Name != "Original copy" {
		t.Fatalf("name=%q, want default %q", dup.Name, "Original copy")
	}
	if len(dup.Assets) != 1 {
		t.Fatalf("assets=%d, want 1", len(dup.Assets))
	}

	// New asset id, and the clip must follow it — otherwise the copy opens with
	// a clip pointing at a library entry it doesn't have.
	a := dup.Assets[0]
	if a.ID == src.Assets[0].ID {
		t.Fatal("duplicate reused the source asset id")
	}
	if got := dup.Tracks[1].Clips[0].AssetID; got != a.ID {
		t.Fatalf("clip assetId=%q, want %q", got, a.ID)
	}

	// The media is copied, not shared: the paths point into the new project and
	// the bytes are really there.
	wantPrefix := filepath.ToSlash(filepath.Join("projects", dup.ID)) + "/"
	for _, rel := range []string{a.Path, a.Thumbnail} {
		if len(rel) < len(wantPrefix) || rel[:len(wantPrefix)] != wantPrefix {
			t.Fatalf("path %q not rebased under %q", rel, wantPrefix)
		}
		if _, err := os.Stat(s.Abs(rel)); err != nil {
			t.Fatalf("copied media missing: %v", err)
		}
	}

	// Deleting the source leaves the copy intact — the whole reason the files
	// are copied rather than shared.
	if err := s.DeleteProject(ctx, src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.Abs(a.Path)); err != nil {
		t.Fatalf("copy's media died with the source: %v", err)
	}
	if _, err := s.GetProject(ctx, dup.ID); err != nil {
		t.Fatalf("copy unreadable after deleting source: %v", err)
	}

	if _, err := s.DuplicateProject(ctx, "proj_missing", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("duplicate missing err=%v, want ErrNotFound", err)
	}
}

func TestDeleteProject(t *testing.T) {
	s := localStore(t)
	ctx := context.Background()
	doc := seedProject(t, s, "Doomed")
	dir := s.projectDir(doc.ID)

	if err := s.DeleteProject(ctx, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("media directory survived: %v", err)
	}
	if _, err := s.GetProject(ctx, doc.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete err=%v, want ErrNotFound", err)
	}
	list, err := s.ListProjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 0 {
		t.Fatalf("list len=%d, want 0", len(list))
	}
	if err := s.DeleteProject(ctx, doc.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err=%v, want ErrNotFound", err)
	}
}
