// Package store persists projects (edit documents) in Postgres and their media
// on disk.
//
// The edit document is split across two tables, and that split is the whole
// point: `projects` holds canvas/tracks/markers — the part the editor owns —
// behind an optimistic-concurrency revision, while `assets` holds one row per
// media file, written by background jobs. A finishing export appending an asset
// therefore cannot clobber an in-flight timeline edit, which a whole-document
// read-modify-write could and did.
//
// Media files themselves stay on the local filesystem under the media root:
//
//	<root>/projects/<id>/assets/...   imported/generated media
//	<root>/projects/<id>/thumbs/...   generated thumbnails
//	<root>/projects/<id>/renders/...  export outputs
//	<root>/projects/<id>/luts/...     color LUTs
//
// Moving those to object storage is a separate step; nothing here assumes they
// stay local except the Abs/Rel helpers.
package store

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"studio/internal/schema"
)

var (
	// ErrNotFound is returned when a project id does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict is returned when a save is based on a stale revision — someone
	// else saved the same timeline in between. The caller should re-read and
	// surface the conflict rather than overwrite.
	ErrConflict = errors.New("conflict: project was modified by someone else")
)

//go:embed schema.sql
var schemaSQL string

// Store is a Postgres-backed project store with filesystem media.
type Store struct {
	db   *pgxpool.Pool
	root string
}

// ProjectMeta is a lightweight listing entry.
type ProjectMeta struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Updated string `json:"updated"`
}

// docBody is the part of an EditDoc the editor owns. Assets are excluded on
// purpose — they have their own table and their own writers, and folding them
// back in here would reintroduce the lost update this split exists to prevent.
type docBody struct {
	Canvas  schema.Canvas   `json:"canvas"`
	Tracks  []schema.Track  `json:"tracks"`
	Markers []schema.Marker `json:"markers,omitempty"`
}

// New connects to Postgres, applies the schema, and returns a Store whose media
// lives under root.
func New(ctx context.Context, databaseURL, root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "projects"), 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	if _, err := db.Exec(ctx, schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &Store{db: db, root: abs}, nil
}

// Close releases the connection pool.
func (s *Store) Close() { s.db.Close() }

// Root returns the absolute media root path.
func (s *Store) Root() string { return s.root }

func (s *Store) projectDir(id string) string { return filepath.Join(s.root, "projects", id) }

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

// LutsDir returns the color-LUT (.cube) directory for a project.
func (s *Store) LutsDir(id string) (string, error) {
	dir := filepath.Join(s.projectDir(id), "luts")
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
func (s *Store) CreateProject(ctx context.Context, name string) (*schema.EditDoc, error) {
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
	body, err := json.Marshal(docBody{Canvas: doc.Canvas, Tracks: doc.Tracks})
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.projectDir(doc.ID), 0o755); err != nil {
		return nil, err
	}
	var updated time.Time
	err = s.db.QueryRow(ctx,
		`INSERT INTO projects (id, name, revision, doc) VALUES ($1, $2, 1, $3)
		 RETURNING updated_at`,
		doc.ID, doc.Name, body).Scan(&updated)
	if err != nil {
		return nil, err
	}
	doc.Updated = updated.UTC().Format(time.RFC3339)
	return doc, nil
}

// GetProject reads an edit document by id, assembling the editor-owned body with
// the project's live assets.
func (s *Store) GetProject(ctx context.Context, id string) (*schema.EditDoc, error) {
	var (
		name     string
		revision int64
		body     []byte
		updated  time.Time
	)
	err := s.db.QueryRow(ctx,
		`SELECT name, revision, doc, updated_at FROM projects WHERE id = $1`, id).
		Scan(&name, &revision, &body, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var b docBody
	if err := json.Unmarshal(body, &b); err != nil {
		return nil, fmt.Errorf("corrupt document for %s: %w", id, err)
	}
	assets, err := s.listAssets(ctx, id)
	if err != nil {
		return nil, err
	}
	return &schema.EditDoc{
		ID:      id,
		Name:    name,
		Version: int(revision),
		Canvas:  b.Canvas,
		Tracks:  b.Tracks,
		Assets:  assets,
		Markers: b.Markers,
		Updated: updated.UTC().Format(time.RFC3339),
	}, nil
}

// listAssets returns a project's non-deleted assets in creation order.
func (s *Store) listAssets(ctx context.Context, projID string) ([]schema.Asset, error) {
	rows, err := s.db.Query(ctx,
		`SELECT data FROM assets
		  WHERE project_id = $1 AND deleted_at IS NULL
		  ORDER BY created_at, id`, projID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	assets := []schema.Asset{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var a schema.Asset
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		assets = append(assets, a)
	}
	return assets, rows.Err()
}

// SaveProject writes the editor-owned part of a document if baseRevision still
// matches what is stored, and returns the new revision. A mismatch means someone
// else saved in between: the caller gets ErrConflict and must not overwrite.
//
// doc.Assets is ignored by design — the asset library is not the editor's to
// replace, and honouring it here is exactly how a finished export used to get
// deleted by the next autosave.
func (s *Store) SaveProject(ctx context.Context, doc *schema.EditDoc, baseRevision int) (int, error) {
	body, err := json.Marshal(docBody{Canvas: doc.Canvas, Tracks: doc.Tracks, Markers: doc.Markers})
	if err != nil {
		return 0, err
	}
	var revision int64
	err = s.db.QueryRow(ctx,
		`UPDATE projects
		    SET name = $2, doc = $3, revision = revision + 1, updated_at = now()
		  WHERE id = $1 AND revision = $4
		  RETURNING revision`,
		doc.ID, doc.Name, body, baseRevision).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		// Either the project is gone or the revision moved on; distinguish so the
		// caller can answer 404 vs 409.
		var exists bool
		if e := s.db.QueryRow(ctx, `SELECT true FROM projects WHERE id = $1`, doc.ID).Scan(&exists); e != nil {
			return 0, ErrNotFound
		}
		return 0, ErrConflict
	}
	if err != nil {
		return 0, err
	}
	return int(revision), nil
}

// ListProjects returns all projects, newest first.
func (s *Store) ListProjects(ctx context.Context) ([]ProjectMeta, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ProjectMeta
	for rows.Next() {
		var (
			m       ProjectMeta
			updated time.Time
		)
		if err := rows.Scan(&m.ID, &m.Name, &updated); err != nil {
			return nil, err
		}
		m.Updated = updated.UTC().Format(time.RFC3339)
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddAsset registers an asset on a project. It does not touch the project's
// revision: an asset arriving from a background job is not a timeline edit and
// must not invalidate an editor's in-flight save.
func (s *Store) AddAsset(ctx context.Context, projID string, asset schema.Asset) error {
	data, err := json.Marshal(asset)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx,
		`INSERT INTO assets (id, project_id, data) VALUES ($1, $2, $3)
		 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, deleted_at = NULL`,
		asset.ID, projID, data)
	return err
}

// UpdateAsset replaces an existing asset's metadata, or inserts it if absent.
// Used by re-render, which regenerates the media file in place and needs to
// refresh the probed duration/size/thumbnail.
func (s *Store) UpdateAsset(ctx context.Context, projID string, asset schema.Asset) error {
	return s.AddAsset(ctx, projID, asset)
}

// DeleteAsset soft-deletes an asset: the row is marked and the media file is
// deliberately left on disk, so a mistaken removal costs nothing to undo and no
// other project or finished render breaks by referencing a vanished file.
func (s *Store) DeleteAsset(ctx context.Context, projID, assetID string) error {
	tag, err := s.db.Exec(ctx,
		`UPDATE assets SET deleted_at = now()
		  WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
		assetID, projID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
