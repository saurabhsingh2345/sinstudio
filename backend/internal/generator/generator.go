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

// Adapter is a generator manifest.
type Adapter struct {
	ID          string      `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	CWD         string      `json:"cwd"`         // dir to run in, relative to studio root
	Command     []string    `json:"command"`     // argv template; {input} {output} substituted
	InputKind   string      `json:"inputKind"`   // lessonJson|htmlComposition
	InputExt    string      `json:"inputExt"`    // e.g. ".json" or ".html"
	OutputExt   string      `json:"outputExt"`   // e.g. "mp4"
	Params      []ParamSpec `json:"params"`      // exposed flags
	SamplePath  string      `json:"samplePath"`  // optional sample input file (relative to cwd)
	BuildHint   string      `json:"buildHint"`   // shown if the CLI is missing
	ProbeBinary string      `json:"probeBinary"` // optional file that must exist under cwd (e.g. dist cli)
}

// Registry holds loaded adapters keyed by id.
type Registry struct {
	root     string // studio root (parent of backend/)
	adapters map[string]Adapter
	order    []string
}

// NewRegistry loads all embedded adapter manifests. root is the studio project
// root, used to resolve each adapter's relative cwd.
func NewRegistry(root string) (*Registry, error) {
	r := &Registry{root: root, adapters: map[string]Adapter{}}
	entries, err := fs.ReadDir(adapterFS, "adapters")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		data, err := adapterFS.ReadFile("adapters/" + e.Name())
		if err != nil {
			return nil, err
		}
		var a Adapter
		if err := json.Unmarshal(data, &a); err != nil {
			return nil, fmt.Errorf("adapter %s: %w", e.Name(), err)
		}
		r.adapters[a.ID] = a
		r.order = append(r.order, a.ID)
	}
	return r, nil
}

// List returns adapters in load order, with availability annotated.
func (r *Registry) List() []AdapterStatus {
	out := make([]AdapterStatus, 0, len(r.order))
	for _, id := range r.order {
		a := r.adapters[id]
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
	a, ok := r.adapters[id]
	if !ok {
		return fmt.Errorf("unknown generator %q", id)
	}
	if err := r.available(a); err != nil {
		return err
	}

	// Write the input file inside the generator cwd so relative asset paths resolve.
	inFile, err := os.CreateTemp(r.cwd(a), "studio-in-*"+a.InputExt)
	if err != nil {
		return err
	}
	defer os.Remove(inFile.Name())
	if _, err := inFile.WriteString(inputContent); err != nil {
		return err
	}
	inFile.Close()

	argv := r.buildArgv(a, inFile.Name(), outputPath, params)
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
