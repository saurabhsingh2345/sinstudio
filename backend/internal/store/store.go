// Package store persists projects (edit documents) and their media on disk.
// Layout under the media root:
//
//	<root>/projects/<id>/timeline.json       the edit document
//	<root>/projects/<id>/assets/...          imported/generated media
//	<root>/projects/<id>/thumbs/...          generated thumbnails
//	<root>/projects/<id>/renders/...         export outputs
//
// A filesystem/JSON store keeps v1 dependency-free. The interface is small
// enough to swap for SQLite (modernc.org/sqlite) later without touching callers.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"studio/internal/schema"
)

// ErrNotFound is returned when a project id does not exist.
var ErrNotFound = errors.New("not found")

// Store is a filesystem-backed project store.
type Store struct {
	root string
	mu   sync.Mutex
}

// ProjectMeta is a lightweight listing entry.
type ProjectMeta struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Updated string `json:"updated"`
}

// New creates (if needed) and returns a Store rooted at the given media dir.
func New(root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &Store{root: abs}, nil
}

// Root returns the absolute media root path.
func (s *Store) Root() string { return s.root }

func (s *Store) projectDir(id string) string { return filepath.Join(s.root, "projects", id) }
func (s *Store) timelinePath(id string) string {
	return filepath.Join(s.projectDir(id), "timeline.json")
}

// AssetsDir returns the assets directory for a project (created on demand).
func (s *Store) AssetsDir(id string) (string, error) {
	dir := filepath.Join(s.projectDir(id), "assets")
	return dir, os.MkdirAll(dir, 0o755)
}

// ThumbsDir returns the thumbnails directory for a project (created on demand).
func (s *Store) ThumbsDir(id string) (string, error) {
	dir := filepath.Join(s.projectDir(id), "thumbs")
	return dir, os.MkdirAll(dir, 0o755)
}

// RendersDir returns the export outputs directory for a project.
func (s *Store) RendersDir(id string) (string, error) {
	dir := filepath.Join(s.projectDir(id), "renders")
	return dir, os.MkdirAll(dir, 0o755)
}

// Rel returns a path relative to the media root (for serving over /media/).
func (s *Store) Rel(abs string) string {
	if r, err := filepath.Rel(s.root, abs); err == nil {
		return filepath.ToSlash(r)
	}
	return abs
}

// Abs resolves a media-root-relative path to an absolute filesystem path.
func (s *Store) Abs(rel string) string { return filepath.Join(s.root, filepath.FromSlash(rel)) }

// NewID returns a short random hex id with the given prefix.
func NewID(prefix string) string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// CreateProject writes a fresh edit document and returns it.
func (s *Store) CreateProject(name string) (*schema.EditDoc, error) {
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
	if err := os.MkdirAll(s.projectDir(doc.ID), 0o755); err != nil {
		return nil, err
	}
	if err := s.SaveProject(doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// GetProject reads and returns an edit document by id.
func (s *Store) GetProject(id string) (*schema.EditDoc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.getProjectLocked(id)
}

// getProjectLocked reads a document; the caller must already hold s.mu.
func (s *Store) getProjectLocked(id string) (*schema.EditDoc, error) {
	data, err := os.ReadFile(s.timelinePath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var doc schema.EditDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("corrupt timeline.json for %s: %w", id, err)
	}
	return &doc, nil
}

// SaveProject writes an edit document atomically, stamping the update time.
func (s *Store) SaveProject(doc *schema.EditDoc) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveProjectLocked(doc)
}

// saveProjectLocked writes a document; the caller must already hold s.mu.
func (s *Store) saveProjectLocked(doc *schema.EditDoc) error {
	if doc.Assets == nil {
		doc.Assets = []schema.Asset{}
	}
	doc.Updated = time.Now().UTC().Format(time.RFC3339)
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.projectDir(doc.ID), 0o755); err != nil {
		return err
	}
	tmp := s.timelinePath(doc.ID) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.timelinePath(doc.ID))
}

// ListProjects returns all projects, newest first.
func (s *Store) ListProjects() ([]ProjectMeta, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, "projects"))
	if err != nil {
		return nil, err
	}
	var out []ProjectMeta
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		doc, err := s.GetProject(e.Name())
		if err != nil {
			continue // skip unreadable dirs
		}
		out = append(out, ProjectMeta{ID: doc.ID, Name: doc.Name, Updated: doc.Updated})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Updated > out[j].Updated })
	return out, nil
}

// AddAsset appends an asset to a project and persists it. The read-modify-write
// is done under a single lock so concurrent jobs (e.g. two generators finishing
// together) can't lost-update each other and drop an asset.
func (s *Store) AddAsset(id string, asset schema.Asset) (*schema.EditDoc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.getProjectLocked(id)
	if err != nil {
		return nil, err
	}
	doc.Assets = append(doc.Assets, asset)
	doc.Version++
	if err := s.saveProjectLocked(doc); err != nil {
		return nil, err
	}
	return doc, nil
}
