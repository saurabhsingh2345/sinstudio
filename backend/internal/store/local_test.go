package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"studio/internal/schema"
)

func TestLocalStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewLocal(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()

	doc, err := s.CreateProject(ctx, "Local test")
	if err != nil {
		t.Fatal(err)
	}
	doc, err = s.GetProject(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Name != "Local test" {
		t.Fatalf("name=%q", doc.Name)
	}

	asset := schema.Asset{ID: "a1", Name: "clip.mp4", Kind: "video", Path: "projects/x/a.mp4"}
	if err := s.AddAsset(ctx, doc.ID, asset); err != nil {
		t.Fatal(err)
	}
	doc.Tracks[1].Clips = []schema.Clip{{ID: "c1", AssetID: "a1", Start: 0, In: 0, Out: 1, Volume: 1}}
	rev, err := s.SaveProject(ctx, doc, doc.Version)
	if err != nil {
		t.Fatal(err)
	}
	if rev != 2 {
		t.Fatalf("revision=%d", rev)
	}

	again, err := s.GetProject(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Assets) != 1 {
		t.Fatalf("assets=%d", len(again.Assets))
	}
	path := filepath.Join(dir, "projects", doc.ID, "timeline.json")
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("timeline.json missing: %v", err)
	}
}

func TestOpenLocal(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(context.Background(), "local", dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !s.local {
		t.Fatal("expected local store")
	}
}
