// Package generator spawns the sibling clip-generator projects (newaniAdv,
// hyperframes) as external CLIs. Each generator is described by a JSON manifest
// under adapters/, so adding a generator is data, not code.
package generator

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"studio/internal/jobs"
)

//go:embed adapters/*.json
var adapterFS embed.FS

// ParamSpec describes a user-tunable flag exposed in the UI.
type ParamSpec struct {
	Flag    string   `json:"flag"`              // e.g. "--voice"
	Label   string   `json:"label"`             // human label
	Type    string   `json:"type"`              // string|bool|enum
	Default string   `json:"default,omitempty"` // default value
	Options []string `json:"options,omitempty"` // for enum
}

// FieldSpec describes one editable property of a generator's *input document*
// (as opposed to ParamSpec, which describes a CLI flag). A generator that
// publishes fields gets a structured editor in Studio for free — both when
// authoring a new clip and when re-editing an existing one — with no
// per-generator UI code. That is what makes the plugin count scalable.
//
// The fields are a *view* over the document, deliberately not a full schema of
// it: the editor reads and writes only the paths named here and leaves every
// other key untouched. So a generator can add a property Studio has never heard
// of without its clips being damaged the next time someone edits them. Being an
// incomplete description is the point, not a limitation.
type FieldSpec struct {
	Path    string      `json:"path"`              // dot path into the document, e.g. "fps" or "scenes[].code"
	Label   string      `json:"label"`             // human label
	Type    string      `json:"type"`              // string|text|number|bool|enum|array
	Default any         `json:"default,omitempty"` // value for a newly-created item
	Options []string    `json:"options,omitempty"` // for enum
	Hint    string      `json:"hint,omitempty"`    // help text under the control
	Mono    bool        `json:"mono,omitempty"`    // render text in a monospace editor (code)
	Fields  []FieldSpec `json:"fields,omitempty"`  // for type "array": the shape of each item
	ItemOf  string      `json:"itemOf,omitempty"`  // for type "array": label of one item, e.g. "Scene"
}

// Preview describes how to render a cheap, throwaway version of a clip while
// someone is editing its properties. Every generator here takes seconds to
// minutes for a real render, so the editor can only feel live if there is a
// deliberately worse render to show in the meantime.
//
// It is expressed as param overrides rather than a separate command, because
// that is what the cheap path actually is for these tools: fewer frames, no
// voice, a smaller resolution. A generator with no Preview block simply has no
// preview, and the editor says so instead of pretending.
type Preview struct {
	Params map[string]string `json:"params"` // merged over the user's params
	Note   string            `json:"note"`   // how the preview differs, shown in the UI
}

// Adapter is a generator manifest.
type Adapter struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	CWD         string      `json:"cwd"`         // dir to run in, relative to studio root
	Command     []string    `json:"command"`     // argv template; {input} {output} substituted
	InputKind   string      `json:"inputKind"`   // lessonJson|htmlComposition
	InputExt    string      `json:"inputExt"`    // e.g. ".json" or ".html"
	InputMode   string      `json:"inputMode"`   // "file" (default) | "dir" (write input as <tmpdir>/index.html, pass the dir)
	OutputExt   string      `json:"outputExt"`   // e.g. "mp4"
	Params      []ParamSpec `json:"params"`      // exposed flags
	Fields      []FieldSpec `json:"fields"`      // editable properties of the input document (empty = raw editor)
	Preview     *Preview    `json:"preview"`     // optional cheap render for live editing
	DocRoot     string      `json:"docRoot"`     // "object" (default) or "array": shape of the input document
	RawKind     string      `json:"rawKind"`     // when no fields: "json" (default) | "text" | "html"
	SamplePath  string      `json:"samplePath"`  // optional sample input file (relative to cwd)
	BuildHint   string      `json:"buildHint"`   // shown if the CLI is missing
	ProbeBinary string      `json:"probeBinary"` // optional file that must exist under cwd (e.g. dist cli)
}

// Registry holds loaded adapters keyed by id.
type Registry struct {
	root string // studio root (parent of backend/)

	// Guards the loaded set, which Reload replaces while requests are reading it.
	mu        sync.RWMutex
	adapters  map[string]Adapter
	order     []string
	pluginDir string      // optional runtime plugin directory
	errs      []LoadError // load failures from the last scan
}

// NewRegistry loads the built-in adapter manifests. root is the studio project
// root, used to resolve each adapter's relative cwd. Call SetPluginDir to layer
// runtime plugins on top.
func NewRegistry(root string) (*Registry, error) {
	adapters, order, err := loadBuiltin()
	if err != nil {
		return nil, err
	}
	return &Registry{root: root, adapters: adapters, order: order}, nil
}

// loadBuiltin reads the compiled-in manifests, in filename order.
func loadBuiltin() (map[string]Adapter, []string, error) {
	entries, err := fs.ReadDir(adapterFS, "adapters")
	if err != nil {
		return nil, nil, err
	}
	adapters := map[string]Adapter{}
	var order []string
	for _, e := range entries {
		data, err := adapterFS.ReadFile("adapters/" + e.Name())
		if err != nil {
			return nil, nil, err
		}
		var a Adapter
		if err := json.Unmarshal(data, &a); err != nil {
			return nil, nil, fmt.Errorf("adapter %s: %w", e.Name(), err)
		}
		adapters[a.ID] = a
		order = append(order, a.ID)
	}
	return adapters, order, nil
}

// List returns adapters in load order, with availability annotated.
func (r *Registry) List() []AdapterStatus {
	r.mu.RLock()
	order := append([]string(nil), r.order...)
	byID := make(map[string]Adapter, len(r.adapters))
	for k, v := range r.adapters {
		byID[k] = v
	}
	r.mu.RUnlock()

	// Availability stats the filesystem, so it runs outside the lock.
	out := make([]AdapterStatus, 0, len(order))
	for _, id := range order {
		a := byID[id]
		out = append(out, AdapterStatus{Adapter: a, Available: r.available(a) == nil})
	}
	return out
}

// AdapterStatus annotates an adapter with runtime availability.
type AdapterStatus struct {
	Adapter
	Available bool `json:"available"`
}

// Get returns an adapter by id.
func (r *Registry) Get(id string) (Adapter, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[id]
	return a, ok
}

func (r *Registry) cwd(a Adapter) string { return filepath.Join(r.root, a.CWD) }

// available checks the generator project exists (and its probe binary, if any).
func (r *Registry) available(a Adapter) error {
	cwd := r.cwd(a)
	if _, err := os.Stat(cwd); err != nil {
		return fmt.Errorf("generator dir missing: %s", cwd)
	}
	if a.ProbeBinary != "" {
		if _, err := os.Stat(filepath.Join(cwd, a.ProbeBinary)); err != nil {
			return fmt.Errorf("%s not built: %s (%s)", a.Name, a.ProbeBinary, a.BuildHint)
		}
	}
	return nil
}

// Generate writes inputContent to a temp file, runs the generator CLI in its
// cwd producing outputPath, and streams stdout/stderr to the job as logs.
func (r *Registry) Generate(ctx context.Context, j *jobs.Job, id, inputContent string, params map[string]string, outputPath string) error {
	a, ok := r.Get(id)
	if !ok {
		return fmt.Errorf("unknown generator %q", id)
	}
	if err := r.available(a); err != nil {
		return err
	}

	// Materialize the input inside the generator cwd so relative asset paths
	// resolve. Two shapes: a single file ({input} → its path), or a directory
	// holding index.html ({input} → the dir) for tools like HyperFrames whose
	// render CLI expects a project directory, not a lone file.
	var inputArg string
	if a.InputMode == "dir" {
		dir, err := os.MkdirTemp(r.cwd(a), "studio-in-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(inputContent), 0o644); err != nil {
			return err
		}
		inputArg = dir
	} else {
		inFile, err := os.CreateTemp(r.cwd(a), "studio-in-*"+a.InputExt)
		if err != nil {
			return err
		}
		defer os.Remove(inFile.Name())
		if _, err := inFile.WriteString(inputContent); err != nil {
			return err
		}
		inFile.Close()
		inputArg = inFile.Name()
	}

	argv := r.buildArgv(a, inputArg, outputPath, params)
	j.Log("$ " + strings.Join(argv, " "))

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = r.cwd(a)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	go streamLines(stdout, j)
	go streamLines(stderr, j)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%s failed: %w", a.Name, err)
	}
	if _, err := os.Stat(outputPath); err != nil {
		return fmt.Errorf("%s produced no output at %s", a.Name, outputPath)
	}
	return nil
}

// buildArgv substitutes {input}/{output} in the command template and appends
// user params (bool flags included only when truthy).
func (r *Registry) buildArgv(a Adapter, input, output string, params map[string]string) []string {
	repl := strings.NewReplacer("{input}", input, "{output}", output)
	argv := make([]string, 0, len(a.Command)+len(params)*2)
	for _, tok := range a.Command {
		argv = append(argv, repl.Replace(tok))
	}
	for _, spec := range a.Params {
		v, ok := params[spec.Flag]
		if !ok {
			v = spec.Default
		}
		if v == "" {
			continue
		}
		if spec.Type == "bool" {
			if v == "true" || v == "1" {
				argv = append(argv, spec.Flag)
			}
			continue
		}
		argv = append(argv, spec.Flag, v)
	}
	return argv
}

func streamLines(rc interface{ Read([]byte) (int, error) }, j *jobs.Job) {
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r\n")
		if line != "" {
			j.Log(line)
		}
	}
}
