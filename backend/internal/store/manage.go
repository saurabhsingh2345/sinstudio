package store

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"studio/internal/schema"
)

// Project-level management: rename, duplicate, delete. Kept apart from the
// read/write path in store.go because these are the operations that move whole
// projects (and their media) around, and each has to keep the row and the
// on-disk directory agreeing with each other.

// RenameProject sets a project's name and returns its refreshed listing entry.
//
// It bumps the revision on purpose. A rename is a change to the document, so an
// editor that has the project open must not go on to autosave the old name over
// it: with the revision moved on, its next save gets a conflict and reloads.
func (s *Store) RenameProject(ctx context.Context, id, name string) (*ProjectMeta, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("name is required")
	}
	if s.local {
		s.mu.Lock()
		defer s.mu.Unlock()
		doc, err := s.readLocal(id)
		if err != nil {
			return nil, err
		}
		doc.Name = name
		doc.Version++
		if err := s.writeLocal(doc); err != nil {
			return nil, err
		}
		return &ProjectMeta{ID: doc.ID, Name: doc.Name, Updated: doc.Updated}, nil
	}
	var updated time.Time
	err := s.db.QueryRow(ctx,
		`UPDATE projects SET name = $2, revision = revision + 1, updated_at = now()
		  WHERE id = $1
		  RETURNING updated_at`, id, name).Scan(&updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &ProjectMeta{ID: id, Name: name, Updated: updated.UTC().Format(time.RFC3339)}, nil
}

// DeleteProject removes a project, its asset rows, and its whole media
// directory.
//
// Unlike DeleteAsset this is a hard delete. A soft-deleted asset stays useful —
// its file is still referenced by finished renders — but a project the user
// removed from the list has nothing left pointing at it, and leaving gigabytes
// of footage behind for a row nobody can reach is not caution, just waste.
func (s *Store) DeleteProject(ctx context.Context, id string) error {
	if id == "" {
		return ErrNotFound
	}
	if s.local {
		s.mu.Lock()
		defer s.mu.Unlock()
		if _, err := s.readLocal(id); err != nil {
			return err
		}
		return os.RemoveAll(s.projectDir(id))
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM projects WHERE id = $1`, id) // assets cascade
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// Media after the row: the row is what the UI reads, so if the unlink fails
	// the project still disappears rather than coming back on the next refresh.
	return os.RemoveAll(s.projectDir(id))
}

// DuplicateProject copies a project — timeline, markers, asset library and the
// media files themselves — into a new project and returns it.
//
// The media really is copied rather than shared. Two projects pointing at one
// set of files would mean deleting either one silently breaks the other, and
// the copy exists precisely so it can be edited (and deleted) independently.
func (s *Store) DuplicateProject(ctx context.Context, srcID, name string) (*schema.EditDoc, error) {
	src, err := s.GetProject(ctx, srcID)
	if err != nil {
		return nil, err
	}
	if name = strings.TrimSpace(name); name == "" {
		name = src.Name + " copy"
	}

	dup := &schema.EditDoc{
		ID:        NewID("proj_"),
		Name:      name,
		Version:   1,
		Canvas:    src.Canvas,
		Tracks:    src.Tracks,
		Markers:   src.Markers,
		Watermark: src.Watermark,
		Assets:    []schema.Asset{},
	}
	dstDir := s.projectDir(dup.ID)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return nil, err
	}
	fail := func(err error) (*schema.EditDoc, error) {
		_ = os.RemoveAll(dstDir)
		return nil, err
	}

	// Renders and previews are outputs, not inputs: a copy starts with an empty
	// export history rather than one claiming files it never produced.
	for _, sub := range []string{"assets", "thumbs", "luts"} {
		if err := copyTree(filepath.Join(s.projectDir(srcID), sub), filepath.Join(dstDir, sub)); err != nil {
			return fail(err)
		}
	}

	// Asset ids are global (assets.id is the primary key), so the copy needs its
	// own — which means every clip that names one has to be repointed.
	oldPrefix := path.Join("projects", srcID)
	newPrefix := path.Join("projects", dup.ID)
	remap := make(map[string]string, len(src.Assets))
	for _, a := range src.Assets {
		c := a
		c.ID = NewID("asset_")
		c.Path = rebase(a.Path, oldPrefix, newPrefix)
		c.Thumbnail = rebase(a.Thumbnail, oldPrefix, newPrefix)
		remap[a.ID] = c.ID
		dup.Assets = append(dup.Assets, c)
	}
	remapAssetIDs(dup, remap)

	if s.local {
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := s.writeLocal(dup); err != nil {
			return fail(err)
		}
		return dup, nil
	}

	body, err := json.Marshal(docBody{Canvas: dup.Canvas, Tracks: dup.Tracks, Markers: dup.Markers})
	if err != nil {
		return fail(err)
	}
	var updated time.Time
	err = s.db.QueryRow(ctx,
		`INSERT INTO projects (id, name, revision, doc) VALUES ($1, $2, 1, $3)
		 RETURNING updated_at`, dup.ID, dup.Name, body).Scan(&updated)
	if err != nil {
		return fail(err)
	}
	for _, a := range dup.Assets {
		if err := s.AddAsset(ctx, dup.ID, a); err != nil {
			// Half a project is worse than none: drop the row (assets cascade) and
			// the directory, and report the failure.
			_, _ = s.db.Exec(ctx, `DELETE FROM projects WHERE id = $1`, dup.ID)
			return fail(err)
		}
	}
	dup.Updated = updated.UTC().Format(time.RFC3339)
	return dup, nil
}

// remapAssetIDs repoints everything in a document that names an asset. Ids
// missing from the map are left alone rather than blanked — an unknown
// reference is already broken, and erasing it would only hide that.
func remapAssetIDs(doc *schema.EditDoc, remap map[string]string) {
	for t := range doc.Tracks {
		for c := range doc.Tracks[t].Clips {
			if id, ok := remap[doc.Tracks[t].Clips[c].AssetID]; ok {
				doc.Tracks[t].Clips[c].AssetID = id
			}
		}
	}
	if doc.Watermark != nil {
		if id, ok := remap[doc.Watermark.AssetID]; ok {
			doc.Watermark.AssetID = id
		}
	}
}

// rebase moves a media-root-relative path from one project directory to
// another. Paths outside the source project (a shared library file, say) are
// returned untouched: they were never the source project's to move.
func rebase(rel, oldPrefix, newPrefix string) string {
	if rel == "" || !strings.HasPrefix(rel, oldPrefix+"/") {
		return rel
	}
	return newPrefix + strings.TrimPrefix(rel, oldPrefix)
}

// copyTree recursively copies src to dst. A missing source is not an error: a
// project that never generated a thumbnail simply has no thumbs directory.
func copyTree(src, dst string) error {
	info, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return copyFile(src, dst, info.Mode())
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		// Regular files and directories only; a symlink here would be pointing
		// somewhere this copy has no business following.
		if e.Type()&os.ModeSymlink != 0 {
			continue
		}
		if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode.Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
