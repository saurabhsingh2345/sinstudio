// Package apps is a lightweight process supervisor for the sibling generator
// projects (newaniAdv, funkycode, hyperframes). Studio can start/stop/restart
// each app's dev server, tail its logs, and health-probe its URL — turning the
// editor into a control room for the whole product suite.
//
// Each app is described by an embedded JSON manifest under manifests/, so
// adding an app is data, not code (mirroring internal/generator's adapters).
package apps

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed manifests/*.json
var manifestFS embed.FS

// Manifest describes how to run and reach one sibling app.
type Manifest struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	CWD         string   `json:"cwd"`     // dir to run in, relative to studio root
	Command     []string `json:"command"` // dev-server argv (e.g. ["npm","run","dev"])
	URL         string   `json:"url"`     // dev URL to open + health-probe
	Health      string   `json:"health"`  // optional health path; defaults to URL
}

// State is a process lifecycle phase.
type State string

const (
	Stopped State = "stopped" // never started, or exited cleanly on request
	Running State = "running" // process is alive
	Exited  State = "exited"  // process died on its own (crash / nonzero exit)
)

const logCap = 500 // per-app rolling log lines kept in memory

// proc is the live state of one supervised app.
type proc struct {
	man     Manifest
	mu      sync.Mutex
	cmd      *exec.Cmd
	state    State
	pid      int
	started  time.Time
	exitMsg  string
	stopping bool // true when the current process was asked to stop
	logs     *ring
}

// Manager supervises all apps.
type Manager struct {
	root  string
	procs map[string]*proc
	order []string
	hc    *http.Client
}

// Status is the JSON view of one app's live state.
type Status struct {
	Manifest
	State   State  `json:"state"`
	PID     int    `json:"pid,omitempty"`
	Uptime  string `json:"uptime,omitempty"`
	Healthy bool   `json:"healthy"`
	Message string `json:"message,omitempty"`
}

// NewManager loads the embedded manifests. root is the studio project root,
// used to resolve each app's relative cwd.
func NewManager(root string) (*Manager, error) {
	m := &Manager{
		root:  root,
		procs: map[string]*proc{},
		hc:    &http.Client{Timeout: 800 * time.Millisecond},
	}
	entries, err := fs.ReadDir(manifestFS, "manifests")
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := manifestFS.ReadFile("manifests/" + name)
		if err != nil {
			return nil, err
		}
		var man Manifest
		if err := json.Unmarshal(data, &man); err != nil {
			return nil, fmt.Errorf("app manifest %s: %w", name, err)
		}
		m.procs[man.ID] = &proc{man: man, state: Stopped, logs: newRing(logCap)}
		m.order = append(m.order, man.ID)
	}
	return m, nil
}

func (m *Manager) dir(p *proc) string { return filepath.Join(m.root, p.man.CWD) }

// List returns every app's current status, probing health for running ones.
func (m *Manager) List() []Status {
	out := make([]Status, 0, len(m.order))
	for _, id := range m.order {
		out = append(out, m.status(m.procs[id]))
	}
	return out
}

func (m *Manager) status(p *proc) Status {
	p.mu.Lock()
	st := Status{
		Manifest: p.man,
		State:    p.state,
		PID:      p.pid,
		Message:  p.exitMsg,
	}
	running := p.state == Running
	started := p.started
	p.mu.Unlock()

	if running {
		st.Uptime = time.Since(started).Truncate(time.Second).String()
		st.Healthy = m.probe(p.man)
	}
	return st
}

// probe does a best-effort HTTP GET against the app URL; any response counts
// as healthy (dev servers often answer 200/404 while booting).
func (m *Manager) probe(man Manifest) bool {
	url := man.URL
	if man.Health != "" {
		url = strings.TrimRight(man.URL, "/") + "/" + strings.TrimLeft(man.Health, "/")
	}
	if url == "" {
		return false
	}
	resp, err := m.hc.Get(url)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

// Start launches the app's dev server if it is not already running. The process
// is placed in its own group so Stop can terminate the whole tree.
func (m *Manager) Start(id string) error {
	p, ok := m.procs[id]
	if !ok {
		return fmt.Errorf("unknown app %q", id)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state == Running {
		return nil
	}
	if len(p.man.Command) == 0 {
		return fmt.Errorf("%s has no command", p.man.Name)
	}
	cmd := exec.Command(p.man.Command[0], p.man.Command[1:]...)
	cmd.Dir = m.dir(p)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		p.state = Exited
		p.exitMsg = err.Error()
		return err
	}
	p.cmd = cmd
	p.pid = cmd.Process.Pid
	p.state = Running
	p.started = time.Now()
	p.exitMsg = ""
	p.stopping = false
	p.logs.add("$ " + strings.Join(p.man.Command, " ") + "  (cwd " + p.man.CWD + ")")
	go streamLines(stdout, p)
	go streamLines(stderr, p)
	go m.reap(p, cmd)
	return nil
}

// reap waits for the process and records how it ended.
func (m *Manager) reap(p *proc, cmd *exec.Cmd) {
	err := cmd.Wait()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cmd != cmd {
		return // superseded by a newer start
	}
	p.cmd = nil
	p.pid = 0
	switch {
	case p.stopping:
		// Terminated on request — a nonzero exit from the signal is expected.
		p.state = Stopped
		p.exitMsg = ""
		p.logs.add("• stopped")
	case err != nil:
		p.state = Exited
		p.exitMsg = err.Error()
		p.logs.add("✖ exited: " + err.Error())
	default:
		p.state = Stopped
		p.exitMsg = ""
		p.logs.add("• stopped")
	}
	p.stopping = false
}

// Stop signals the app's process group to terminate, escalating to SIGKILL
// after a short grace period.
func (m *Manager) Stop(id string) error {
	p, ok := m.procs[id]
	if !ok {
		return fmt.Errorf("unknown app %q", id)
	}
	p.mu.Lock()
	cmd := p.cmd
	if cmd != nil {
		p.stopping = true
	}
	p.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	killGroup(pid, syscall.SIGTERM)
	go func() {
		time.Sleep(4 * time.Second)
		killGroup(pid, syscall.SIGKILL)
	}()
	return nil
}

// Restart stops the app, waits briefly for it to exit, then starts it again.
func (m *Manager) Restart(id string) error {
	if err := m.Stop(id); err != nil {
		return err
	}
	go func() {
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			p := m.procs[id]
			p.mu.Lock()
			running := p.state == Running
			p.mu.Unlock()
			if !running {
				break
			}
			time.Sleep(150 * time.Millisecond)
		}
		_ = m.Start(id)
	}()
	return nil
}

// Logs returns a snapshot of the app's recent log lines.
func (m *Manager) Logs(id string) ([]string, error) {
	p, ok := m.procs[id]
	if !ok {
		return nil, fmt.Errorf("unknown app %q", id)
	}
	return p.logs.snapshot(), nil
}

// StopAll terminates every running app (used on shutdown).
func (m *Manager) StopAll() {
	for _, id := range m.order {
		_ = m.Stop(id)
	}
}

func killGroup(pid int, sig syscall.Signal) {
	if pgid, err := syscall.Getpgid(pid); err == nil {
		_ = syscall.Kill(-pgid, sig)
	} else {
		_ = syscall.Kill(pid, sig)
	}
}

func streamLines(rc io.Reader, p *proc) {
	sc := bufio.NewScanner(rc)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r\n")
		if line != "" {
			p.logs.add(line)
		}
	}
}

// ring is a fixed-capacity rolling line buffer.
type ring struct {
	mu  sync.Mutex
	buf []string
	max int
}

func newRing(max int) *ring { return &ring{max: max} }

func (r *ring) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf = append(r.buf, s)
	if len(r.buf) > r.max {
		r.buf = r.buf[len(r.buf)-r.max:]
	}
}

func (r *ring) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.buf))
	copy(out, r.buf)
	return out
}
