package generator

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Runtime plugin loading.
//
// The four original generators are compiled into the binary, which means adding
// a fifth needs a Studio rebuild — fine for four, not for dozens. A plugin
// directory is scanned on top of them so a plugin can be added, edited, or
// patched by dropping a folder, and a manifest fixed without a release.
//
// Layout, one directory per plugin so it has somewhere to keep the rest of
// itself (a bundled editor, samples) as the contract grows:
//
//	<plugins>/<id>/plugin.json
//
// A runtime plugin whose id matches a built-in replaces it, so a built-in can be
// corrected in place.

// pluginManifestName is the file that makes a directory a plugin.
const pluginManifestName = "plugin.json"

// LoadError records a plugin that could not be loaded. Loading is deliberately
// non-fatal: one bad manifest dropped in by one person must not stop the server
// for everyone else, so the error is collected and surfaced instead of returned.
type LoadError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// PluginDir returns the directory being scanned ("" when none is configured).
func (r *Registry) PluginDir() string { return r.pluginDir }

// Errors returns the load failures from the most recent scan. Always non-nil
// so it serializes as a JSON array — the frontend doesn't null-check it.
func (r *Registry) Errors() []LoadError {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]LoadError, len(r.errs))
	copy(out, r.errs)
	return out
}

// SetPluginDir points the registry at a plugin directory and scans it.
func (r *Registry) SetPluginDir(dir string) {
	r.mu.Lock()
	r.pluginDir = dir
	r.mu.Unlock()
	r.Reload()
}

// Reload re-applies the built-in manifests and re-scans the plugin directory, so
// a manifest edit takes effect without restarting. Built-ins are re-applied
// first, which is what lets a removed override revert to the compiled-in version.
func (r *Registry) Reload() {
	builtin, order, err := loadBuiltin()
	if err != nil {
		// The embedded manifests are compiled in; a failure here is a build
		// problem, not a user one. Keep serving what we already have.
		r.mu.Lock()
		r.errs = []LoadError{{Path: "embedded", Error: err.Error()}}
		r.mu.Unlock()
		return
	}

	r.mu.RLock()
	dir := r.pluginDir
	r.mu.RUnlock()

	loaded, errs := scanPluginDir(dir)
	for _, a := range loaded {
		if _, existing := builtin[a.ID]; !existing {
			order = append(order, a.ID)
		}
		builtin[a.ID] = a // a runtime plugin replaces a built-in of the same id
	}

	r.mu.Lock()
	r.adapters, r.order, r.errs = builtin, order, errs
	r.mu.Unlock()
}

// scanPluginDir reads <dir>/*/plugin.json, returning the valid plugins and one
// error entry per plugin that failed.
func scanPluginDir(dir string) ([]Adapter, []LoadError) {
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // no plugin dir is normal, not an error
		}
		return nil, []LoadError{{Path: dir, Error: err.Error()}}
	}

	var (
		out  []Adapter
		errs []LoadError
	)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name(), pluginManifestName)
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				errs = append(errs, LoadError{Path: path, Error: err.Error()})
			}
			continue // a directory without a manifest simply isn't a plugin
		}
		var a Adapter
		if err := json.Unmarshal(data, &a); err != nil {
			errs = append(errs, LoadError{Path: path, Error: "invalid JSON: " + err.Error()})
			continue
		}
		if a.ID == "" {
			a.ID = e.Name() // default the id to the directory name
		}
		if err := Validate(a); err != nil {
			errs = append(errs, LoadError{Path: path, Error: err.Error()})
			continue
		}
		out = append(out, a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, errs
}

// Validate checks a manifest well enough that a bad one is reported at load
// rather than showing up as a broken control or a command that can't run. The
// field rules mirror what the generic editor can actually render.
func Validate(a Adapter) error {
	if a.ID == "" {
		return fmt.Errorf("missing id")
	}
	if a.Name == "" {
		return fmt.Errorf("%s: missing name", a.ID)
	}
	if len(a.Command) == 0 {
		return fmt.Errorf("%s: missing command", a.ID)
	}
	if !strings.Contains(strings.Join(a.Command, " "), "{output}") {
		return fmt.Errorf("%s: command has no {output} placeholder", a.ID)
	}
	if a.CWD == "" {
		return fmt.Errorf("%s: missing cwd", a.ID)
	}
	// A plugin directory is dropped in by hand, so an absolute or escaping cwd is
	// a plausible mistake and a nasty one — it would run a command anywhere on the
	// filesystem. Keep generators inside the project tree.
	if filepath.IsAbs(a.CWD) {
		return fmt.Errorf("%s: cwd must be relative to the studio root", a.ID)
	}
	for _, p := range a.Params {
		if p.Flag == "" {
			return fmt.Errorf("%s: param with no flag", a.ID)
		}
		if p.Type == "enum" && len(p.Options) == 0 {
			return fmt.Errorf("%s: enum param %q has no options", a.ID, p.Flag)
		}
	}
	for _, f := range a.Fields {
		if err := validateField(a.ID, f, false); err != nil {
			return err
		}
	}
	return nil
}

func validateField(id string, f FieldSpec, nested bool) error {
	switch f.Type {
	case "string", "text", "number", "bool", "enum", "array":
	default:
		return fmt.Errorf("%s: field %q has unknown type %q", id, f.Path, f.Type)
	}
	if f.Path == "" || f.Label == "" {
		return fmt.Errorf("%s: every field needs a path and a label", id)
	}
	if f.Type == "enum" && len(f.Options) == 0 {
		return fmt.Errorf("%s: enum field %q has no options", id, f.Path)
	}
	if f.Type == "array" {
		if nested {
			// The editor resolves a single "[]" hop; a nested array would render
			// controls that write to the wrong path.
			return fmt.Errorf("%s: nested array field %q is not supported", id, f.Path)
		}
		if len(f.Fields) == 0 {
			return fmt.Errorf("%s: array field %q declares no item fields", id, f.Path)
		}
		for _, sub := range f.Fields {
			if err := validateField(id, sub, true); err != nil {
				return err
			}
		}
	}
	return nil
}
