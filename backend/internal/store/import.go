package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"studio/internal/schema"
)

// ImportLegacy loads any pre-Postgres timeline.json documents found under the
// media root into the database, and returns how many it imported.
//
// It skips projects that already exist, so it is safe to run on every startup,
// and it never modifies or deletes the JSON files — they stay put as a backup
// until someone decides to remove them by hand.
func (s *Store) ImportLegacy(ctx context.Context) (int, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	imported := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(s.root, "projects", e.Name(), "timeline.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			continue // no legacy document here
		}
		var doc schema.EditDoc
		if err := json.Unmarshal(raw, &doc); err != nil {
			return imported, err
		}
		if doc.ID == "" {
			doc.ID = e.Name()
		}
		// Already migrated (or a project created since) — leave it alone.
		if _, err := s.GetProject(ctx, doc.ID); err == nil {
			continue
		} else if !errors.Is(err, ErrNotFound) {
			return imported, err
		}
		if err := s.importDoc(ctx, &doc); err != nil {
			return imported, err
		}
		imported++
	}
	return imported, nil
}

// importDoc inserts one legacy document and its assets in a single transaction,
// so a failure part-way can't leave a project with half its media.
func (s *Store) importDoc(ctx context.Context, doc *schema.EditDoc) error {
	body, err := json.Marshal(docBody{Canvas: doc.Canvas, Tracks: doc.Tracks, Markers: doc.Markers})
	if err != nil {
		return err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	name := doc.Name
	if name == "" {
		name = "Untitled"
	}
	// Revision restarts at 1. The old Version was incremented by client and
	// server independently, so its value carries no usable ordering.
	if _, err := tx.Exec(ctx,
		`INSERT INTO projects (id, name, revision, doc) VALUES ($1, $2, 1, $3)`,
		doc.ID, name, body); err != nil {
		return err
	}
	for _, a := range doc.Assets {
		data, err := json.Marshal(a)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO assets (id, project_id, data) VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO NOTHING`,
			a.ID, doc.ID, data); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
