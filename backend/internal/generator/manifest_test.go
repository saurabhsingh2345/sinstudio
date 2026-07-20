package generator

import "testing"

// TestManifestsLoad guards the adapter manifests as data: they are embedded JSON
// with no compiler checking them, so a typo would otherwise surface as a
// mysteriously missing generator at runtime.
func TestManifestsLoad(t *testing.T) {
	r, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("load manifests: %v", err)
	}
	for _, want := range []string{"funkycode", "hyperframes", "kokorovoice", "newaniadv"} {
		if _, ok := r.Get(want); !ok {
			t.Errorf("adapter %q missing", want)
		}
	}
}

// TestFieldSpecsAreWellFormed checks the input-document schemas the UI renders
// generically. A malformed spec doesn't fail the build — it produces a broken or
// blank control in the editor — so validate the invariants here instead.
func TestFieldSpecsAreWellFormed(t *testing.T) {
	r, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	valid := map[string]bool{"string": true, "text": true, "number": true, "bool": true, "enum": true, "array": true}

	var check func(t *testing.T, id string, f FieldSpec, nested bool)
	check = func(t *testing.T, id string, f FieldSpec, nested bool) {
		if f.Path == "" || f.Label == "" {
			t.Errorf("%s: field %+v needs both a path and a label", id, f)
		}
		if !valid[f.Type] {
			t.Errorf("%s: field %q has unknown type %q", id, f.Path, f.Type)
		}
		if f.Type == "enum" && len(f.Options) == 0 {
			t.Errorf("%s: enum field %q has no options", id, f.Path)
		}
		if f.Type == "array" {
			if nested {
				// The editor resolves a single "[]" hop; nesting arrays would
				// render controls that silently write to the wrong path.
				t.Errorf("%s: array field %q is nested — not supported", id, f.Path)
			}
			if len(f.Fields) == 0 {
				t.Errorf("%s: array field %q declares no item fields", id, f.Path)
			}
			for _, sub := range f.Fields {
				check(t, id, sub, true)
			}
		}
	}

	for _, a := range r.List() {
		for _, f := range a.Fields {
			check(t, a.ID, f, false)
		}
		// A generator with no schema is edited raw, so it must say in what format.
		if len(a.Fields) == 0 && a.RawKind == "" && a.InputExt != ".json" {
			t.Errorf("%s: no fields and no rawKind — the raw editor can't label itself", a.ID)
		}
	}
}

// TestFunkyCodeSchemaMatchesCLI pins the FunkyCode field schema against the
// document its CLI actually consumes. This schema replaced a hand-written
// TypeScript mirror that drifted; if it drifts again, clips get edited into a
// shape the renderer ignores.
func TestFunkyCodeSchemaMatchesCLI(t *testing.T) {
	r, _ := NewRegistry(t.TempDir())
	a, ok := r.Get("funkycode")
	if !ok {
		t.Fatal("funkycode adapter missing")
	}
	if len(a.Fields) != 1 || a.Fields[0].Path != "scenes[]" {
		t.Fatalf("expected a single scenes[] array field, got %+v", a.Fields)
	}
	got := map[string]FieldSpec{}
	for _, f := range a.Fields[0].Fields {
		got[f.Path] = f
	}
	for _, want := range []string{"code", "language", "template", "output", "throwCount"} {
		if _, ok := got[want]; !ok {
			t.Errorf("scene field %q missing from the schema", want)
		}
	}
	// The template IS the theme in FunkyCode, and only these five exist.
	for _, tmpl := range []string{"panel", "spotlight", "paper", "liverun", "liverundark"} {
		found := false
		for _, o := range got["template"].Options {
			if o == tmpl {
				found = true
			}
		}
		if !found {
			t.Errorf("template option %q missing", tmpl)
		}
	}
}
