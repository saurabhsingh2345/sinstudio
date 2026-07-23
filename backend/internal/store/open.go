package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"studio/internal/schema"
)

// NewLocal opens a filesystem-backed store — no Postgres required.
// Each project lives at <root>/projects/<id>/timeline.json (full EditDoc).
// Use STUDIO_DATABASE_URL=local in dev or solo deployments.
func NewLocal(root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Store{root: abs, local: true, mu: &sync.Mutex{}}, nil
}

func (s *Store) timelinePath(id string) string {
	return filepath.Join(s.projectDir(id), "timeline.json")
}

func (s *Store) readLocal(id string) (*schema.EditDoc, error) {
	raw, err := os.ReadFile(s.timelinePath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var doc schema.EditDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("corrupt timeline.json for %s: %w", id, err)
	}
	if doc.ID == "" {
		doc.ID = id
	}
	if doc.Version == 0 {
		doc.Version = 1
	}
	return &doc, nil
}

func (s *Store) writeLocal(doc *schema.EditDoc) error {
	if err := os.MkdirAll(s.projectDir(doc.ID), 0o755); err != nil {
		return err
	}
	doc.Updated = time.Now().UTC().Format(time.RFC3339)
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.timelinePath(doc.ID) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.timelinePath(doc.ID))
}

func (s *Store) createProjectLocal(_ context.Context, name string) (*schema.EditDoc, error) {
	if name == "" {
		name = "Untitled"
	}
	doc := &schema.EditDoc{
		ID:      NewID("proj_"),
		Name:    name,
		Version: 1,
		Canvas:  schema.Canvas{Width: 1920, Height: 1080, FPS: 30},
		Tracks:  schema.DefaultTracks(),
		Assets:  []schema.Asset{},
	}
	if err := s.writeLocal(doc); err != nil {
		return nil, err
	}
	return doc, nil
}

func (s *Store) saveProjectLocal(doc *schema.EditDoc, baseRevision int) (int, error) {
	cur, err := s.readLocal(doc.ID)
	if err != nil {
		return 0, err
	}
	if cur.Version != baseRevision {
		return 0, ErrConflict
	}
	cur.Name = doc.Name
	cur.Canvas = doc.Canvas
	cur.Tracks = doc.Tracks
	cur.Markers = doc.Markers
	cur.Version = baseRevision + 1
	if err := s.writeLocal(cur); err != nil {
		return 0, err
	}
	return cur.Version, nil
}

func (s *Store) listProjectsLocal(_ context.Context) ([]ProjectMeta, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []ProjectMeta
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		doc, err := s.readLocal(e.Name())
		if err != nil {
			continue
		}
		updated := doc.Updated
		if updated == "" {
			if info, err := e.Info(); err == nil {
				updated = info.ModTime().UTC().Format(time.RFC3339)
			}
		}
		out = append(out, ProjectMeta{ID: doc.ID, Name: doc.Name, Updated: updated})
	}
	return out, nil
}

func (s *Store) addAssetLocal(_ context.Context, projID string, asset schema.Asset) error {
	doc, err := s.readLocal(projID)
	if err != nil {
		return err
	}
	found := false
	for i, a := range doc.Assets {
		if a.ID == asset.ID {
			doc.Assets[i] = asset
			found = true
			break
		}
	}
	if !found {
		doc.Assets = append(doc.Assets, asset)
	}
	return s.writeLocal(doc)
}

func (s *Store) deleteAssetLocal(_ context.Context, projID, assetID string) error {
	doc, err := s.readLocal(projID)
	if err != nil {
		return err
	}
	n := len(doc.Assets)
	doc.Assets = filterAssets(doc.Assets, assetID)
	if len(doc.Assets) == n {
		return ErrNotFound
	}
	return s.writeLocal(doc)
}

func filterAssets(assets []schema.Asset, drop string) []schema.Asset {
	out := assets[:0]
	for _, a := range assets {
		if a.ID != drop {
			out = append(out, a)
		}
	}
	return out
}

// Open connects using postgres://, sqlite://<path>, or local (filesystem JSON).
func Open(ctx context.Context, databaseURL, root string) (*Store, error) {
	url := databaseURL
	switch {
	case url == "":
		return nil, errors.New("STUDIO_DATABASE_URL is required")
	case url == "local":
		return NewLocal(root)
	default:
		return New(ctx, url, root)
	}
}
