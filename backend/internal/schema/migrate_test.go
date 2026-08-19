package schema

import "testing"

func clipWith(f func(*Clip)) Clip {
	c := Clip{ID: "c", AssetID: "a", Out: 5}
	f(&c)
	return c
}

func docOf(clips ...Clip) *EditDoc {
	return &EditDoc{Tracks: []Track{{ID: "v", Kind: TrackVideo, Clips: clips}}}
}

// The point of the migration: a clip that WAS being filled goes on being filled.
func TestMigrateFillsWhatTheOldRuleFilled(t *testing.T) {
	doc := docOf(
		clipWith(func(c *Clip) { c.Cursor = &CursorFX{} }),
		clipWith(func(c *Clip) {
			c.Keyframes = map[string][]Keyframe{"scale": {{T: 0, Value: 1}, {T: 2, Value: 1.8}}}
		}),
	)
	MigrateFit(doc)
	for i, c := range doc.Tracks[0].Clips {
		if c.Fit != FitCover {
			t.Errorf("clip %d was being filled and is now %q", i, c.Fit)
		}
	}
}

// And a clip that was NOT being filled keeps the default, which now letterboxes.
func TestMigrateLeavesEverythingElseAlone(t *testing.T) {
	doc := docOf(
		clipWith(func(c *Clip) {}),
		clipWith(func(c *Clip) { c.Title = &Title{Text: "hi"} }),
		clipWith(func(c *Clip) { c.Annotation = &Annotation{Kind: "box"} }),
		// A pan with no zoom: the old rule looked at scale past 1.02 and nothing
		// else, so this was letterboxed and must stay that way.
		clipWith(func(c *Clip) {
			c.Keyframes = map[string][]Keyframe{"x": {{T: 0, Value: 0}, {T: 2, Value: 200}}}
		}),
		// A scale that never gets going is not a zoom either.
		clipWith(func(c *Clip) {
			c.Keyframes = map[string][]Keyframe{"scale": {{T: 0, Value: 1}, {T: 2, Value: 1.01}}}
		}),
	)
	MigrateFit(doc)
	for i, c := range doc.Tracks[0].Clips {
		if c.Fit != FitAuto {
			t.Errorf("clip %d was letterboxed and is now %q", i, c.Fit)
		}
	}
}

func TestMigrateNeverOverridesAChoice(t *testing.T) {
	doc := docOf(clipWith(func(c *Clip) {
		c.Cursor = &CursorFX{}
		c.Fit = FitContain // asked for bars, explicitly
	}))
	MigrateFit(doc)
	if got := doc.Tracks[0].Clips[0].Fit; got != FitContain {
		t.Errorf("an explicit fit was overwritten with %q", got)
	}
}

/*
THE ONE THAT MATTERS. This is a one-time upgrade, not the old rule kept alive.

Without the stamp, a clip created after the change — letterboxed on purpose —
would be converted to `fill` the moment anyone added a zoom to it, on the very
next read. That is the silent cropping being removed, coming back through the
migration. The first version of this had exactly that bug.
*/
func TestMigrateRunsOnceAndOnlyOnce(t *testing.T) {
	doc := docOf(clipWith(func(c *Clip) { c.Cursor = &CursorFX{} }))
	MigrateFit(doc)
	if doc.SchemaRev != FitSchemaRev {
		t.Fatalf("no stamp after migrating: %d", doc.SchemaRev)
	}

	// Someone letterboxes it deliberately and adds a zoom, as they now may.
	doc.Tracks[0].Clips[0].Fit = FitAuto
	doc.Tracks[0].Clips[0].Keyframes = map[string][]Keyframe{
		"scale": {{T: 0, Value: 1}, {T: 2, Value: 2}},
	}
	MigrateFit(doc)
	if got := doc.Tracks[0].Clips[0].Fit; got != FitAuto {
		t.Errorf("a current document was migrated again and its clip became %q", got)
	}
}

func TestMigrateHandlesNothing(t *testing.T) {
	MigrateFit(nil) // must not panic
	doc := &EditDoc{}
	MigrateFit(doc)
	if doc.SchemaRev != FitSchemaRev {
		t.Errorf("an empty document was left unstamped and will migrate forever")
	}
}
