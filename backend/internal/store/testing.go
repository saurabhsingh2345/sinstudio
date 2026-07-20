package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
)

// defaultTestDatabaseURL matches the postgres service in docker-compose.yml, so
// `docker compose up -d postgres` is all a developer needs to run the tests.
const defaultTestDatabaseURL = "postgres://studio:studio@localhost:5544/studio?sslmode=disable"

// TestDatabaseURL returns the database tests should run against, overridable
// with STUDIO_TEST_DATABASE_URL.
func TestDatabaseURL() string {
	if v := os.Getenv("STUDIO_TEST_DATABASE_URL"); v != "" {
		return v
	}
	return defaultTestDatabaseURL
}

// NewTest returns a Store backed by a throwaway Postgres schema and a temp media
// dir, both dropped when the test ends. Every test gets its own schema, so they
// are isolated and can run in parallel against one database.
//
// The test is skipped — not failed — when no database is reachable, matching how
// the ffmpeg-dependent tests behave. Start one with `docker compose up -d postgres`.
func NewTest(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()

	base := TestDatabaseURL()
	admin, err := New(ctx, base, t.TempDir())
	if err != nil {
		t.Skipf("no test database (%v); run: docker compose up -d postgres", err)
	}

	schema := "test_" + NewID("")
	if _, err := admin.db.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.db.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	// Point a second pool at the throwaway schema; New then applies the table
	// definitions inside it.
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse database url: %v", err)
	}
	q := u.Query()
	q.Set("options", fmt.Sprintf("-c search_path=%s", schema))
	u.RawQuery = q.Encode()

	st, err := New(ctx, u.String(), t.TempDir())
	if err != nil {
		t.Fatalf("test store: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}
