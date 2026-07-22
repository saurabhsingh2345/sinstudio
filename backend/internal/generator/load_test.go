package generator

import (
	"os"
	"path/filepath"
	"testing"
)

// writePlugin creates <dir>/<id>/plugin.json with the given manifest body.
func writePlugin(t *testing.T, dir, id, body string) {
	t.Helper()
	sub := filepath.Join(dir, id)
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "plugin.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

const validPlugin = `{
  "id": "demo",
  "name": "Demo",
  "cwd": "../demo",
  "command": ["node", "render.js", "{input}", "{output}"],
  "outputExt": "mp4",
  "fields": [{ "path": "title", "label": "Title", "type": "string" }]
}`

// TestRuntimePluginIsLoaded is the point of the whole mechanism: a plugin added
// as a directory shows up without rebuilding Studio.
func TestRuntimePluginIsLoaded(t *testing.T) {
	dir := t.TempDir()
	writePlugin(t, dir, "demo", validPlugin)

	r, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Get("demo"); ok {
		t.Fatal("demo should not exist before the plugin dir is set")
	}
	r.SetPluginDir(dir)

	a, ok := r.Get("demo")
	if !ok {
		t.Fatal("runtime plugin was not loaded")
	}
	if a.Name != "Demo" || len(a.Fields) != 1 {
		t.Fatalf("loaded manifest is wrong: %+v", a)
	}
	if errs := r.Errors(); len(errs) != 0 {
		t.Fatalf("unexpected load errors: %+v", errs)
	}
	// Built-ins survive alongside it.
	if _, ok := r.Get("funkycode"); !ok {
		t.Error("built-in adapter disappeared when a plugin dir was added")
	}
}

// TestRuntimePluginOverridesBuiltin lets a compiled-in manifest be corrected
// without a release.
func TestRuntimePluginOverridesBuiltin(t *testing.T) {
	dir := t.TempDir()
	writePlugin(t, dir, "funkycode", `{
	  "id": "funkycode", "name": "Patched FunkyCode", "cwd": "../funkycode",
	  "command": ["node", "x.js", "{input}", "{output}"], "outputExt": "mp4"
	}`)
	r, _ := NewRegistry(t.TempDir())
	r.SetPluginDir(dir)

	a, _ := r.Get("funkycode")
	if a.Name != "Patched FunkyCode" {
		t.Fatalf("override did not take effect: %q", a.Name)
	}
	// It replaces rather than duplicates.
	seen := 0
	for _, s := range r.List() {
		if s.ID == "funkycode" {
			seen++
		}
	}
	if seen != 1 {
		t.Fatalf("funkycode listed %d times, want 1", seen)
	}
}

// TestBadPluginIsReportedNotFatal — one person dropping a broken manifest must
// not take the server down for everyone else.
func TestBadPluginIsReportedNotFatal(t *testing.T) {
	dir := t.TempDir()
	writePlugin(t, dir, "broken", `{ not json `)
	writePlugin(t, dir, "nocmd", `{ "id": "nocmd", "name": "No Command", "cwd": "../x" }`)
	writePlugin(t, dir, "escape", `{
	  "id": "escape", "name": "Escape", "cwd": "/etc",
	  "command": ["sh", "{output}"]
	}`)
	writePlugin(t, dir, "demo", validPlugin)

	r, _ := NewRegistry(t.TempDir())
	r.SetPluginDir(dir)

	if _, ok := r.Get("demo"); !ok {
		t.Error("a valid plugin should still load alongside broken ones")
	}
	for _, bad := range []string{"broken", "nocmd", "escape"} {
		if _, ok := r.Get(bad); ok {
			t.Errorf("invalid plugin %q was loaded", bad)
		}
	}
	if len(r.Errors()) != 3 {
		t.Fatalf("got %d load errors, want 3: %+v", len(r.Errors()), r.Errors())
	}
}

// TestReloadPicksUpChanges covers editing a manifest without restarting, and
// that removing an override reverts to the built-in.
func TestReloadPicksUpChanges(t *testing.T) {
	dir := t.TempDir()
	r, _ := NewRegistry(t.TempDir())
	r.SetPluginDir(dir)

	builtin, _ := r.Get("funkycode")
	writePlugin(t, dir, "funkycode", `{
	  "id": "funkycode", "name": "Patched", "cwd": "../funkycode",
	  "command": ["node", "x.js", "{input}", "{output}"], "outputExt": "mp4"
	}`)
	r.Reload()
	if a, _ := r.Get("funkycode"); a.Name != "Patched" {
		t.Fatalf("reload did not pick up the override: %q", a.Name)
	}

	if err := os.RemoveAll(filepath.Join(dir, "funkycode")); err != nil {
		t.Fatal(err)
	}
	r.Reload()
	if a, _ := r.Get("funkycode"); a.Name != builtin.Name {
		t.Fatalf("removing the override should revert to the built-in %q, got %q", builtin.Name, a.Name)
	}
}

// TestMissingPluginDirIsFine — not having a plugin directory is the normal case.
func TestMissingPluginDirIsFine(t *testing.T) {
	r, _ := NewRegistry(t.TempDir())
	r.SetPluginDir(filepath.Join(t.TempDir(), "does-not-exist"))
	if errs := r.Errors(); len(errs) != 0 {
		t.Fatalf("absent plugin dir should not be an error: %+v", errs)
	}
	if _, ok := r.Get("funkycode"); !ok {
		t.Error("built-ins should still load")
	}
}
