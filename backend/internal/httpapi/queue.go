package httpapi

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"studio/internal/jobs"
	"studio/internal/render"
	"studio/internal/schema"
	"studio/internal/store"
	"studio/internal/transcribe"
)

// Work lanes. Each lane is an independently-bounded worker pool, so a 20-minute
// export can't starve a quick clip generation the way a single shared pool would.
// The split is by required tooling (ffmpeg / plugin runtimes / whisper), which is
// also how work would be sharded across machines later: a worker joins only the
// lanes whose binaries it actually has.
const (
	laneRender     = "render"
	lanePlugin     = "plugin"
	laneTranscribe = "transcribe"
)

// Task kinds. Also the job "kind" the UI labels progress with.
const (
	kindExport     = "export"
	kindGenerate   = "generate"
	kindRerender   = "rerender"
	kindTranscribe = "transcribe"
)

// Per-kind wall-clock bounds; the job context is canceled at the deadline, which
// kills the subprocess.
const (
	exportTimeout     = 30 * time.Minute
	generateTimeout   = 15 * time.Minute
	transcribeTimeout = 30 * time.Minute
)

// taskHistoryCap bounds how many completed tasks stay retryable, so a
// long-running server doesn't retain every request it has ever served.
const taskHistoryCap = 200

// Task payloads are the complete API-level inputs to a task, and are deliberately
// JSON-serializable: the queue dispatches in-process today, but "kind + payload"
// is the shape a durable queue (one row per task) needs, so swapping the
// transport later won't touch the call sites or these types.
type (
	exportPayload struct {
		ProjID string          `json:"projId"`
		Doc    *schema.EditDoc `json:"doc"`
		Opts   render.Options  `json:"opts"`
	}

	generatePayload struct {
		ProjID      string            `json:"projId"`
		GeneratorID string            `json:"generatorId"`
		Input       string            `json:"input"`
		Params      map[string]string `json:"params"`
	}

	rerenderPayload struct {
		ProjID  string            `json:"projId"`
		AssetID string            `json:"assetId"`
		Source  string            `json:"source"` // generator that produced the asset
		Name    string            `json:"name"`
		Input   string            `json:"input"`
		Params  map[string]string `json:"params"`
	}

	transcribePayload struct {
		ProjID string `json:"projId"`
		SrcRel string `json:"srcRel"`
	}
)

// task is one unit of queued work: a serializable payload plus the state resolved
// when it was admitted to the queue.
type task struct {
	Kind    string
	Lane    string
	Payload any // replayed verbatim by Retry
	job     *jobs.Job

	// Resolved at enqueue and valid only in this process. A durable queue would
	// drop these and re-derive them in the worker from Payload.
	assetID string
	outPath string
	plan    *render.Plan
}

// workQueue routes every long-running action through a bounded, lane-partitioned
// worker pool. Tasks sit in the "queued" job state until a worker frees up, so a
// burst of requests can't thrash the machine — each task is an ffmpeg, plugin, or
// whisper subprocess. Inputs are remembered so any kind can be retried verbatim.
type workQueue struct {
	srv   *Server
	lanes map[string]chan *task

	mu    sync.Mutex
	tasks map[string]*task // jobID -> task, for Retry
	order []string         // insertion order, for bounded eviction
}

// newWorkQueue starts the worker pools described by sizes (lane -> concurrency).
func newWorkQueue(srv *Server, sizes map[string]int) *workQueue {
	q := &workQueue{srv: srv, lanes: map[string]chan *task{}, tasks: map[string]*task{}}
	for lane, n := range sizes {
		if n < 1 {
			n = 1
		}
		ch := make(chan *task, 128)
		q.lanes[lane] = ch
		for i := 0; i < n; i++ {
			go q.worker(ch)
		}
	}
	return q
}

func (q *workQueue) worker(ch chan *task) {
	for t := range ch {
		q.run(t)
	}
}

// Enqueue validates and admits a task, returning its queued job id. The kind and
// lane are derived from the payload type, so a task can't be dispatched to a
// handler that doesn't match its inputs. Validation happens here rather than in
// the worker so a bad request fails the HTTP call with a 4xx instead of
// surfacing minutes later as a failed job.
func (q *workQueue) Enqueue(payload any) (string, error) {
	t := &task{Payload: payload}
	var timeout time.Duration

	switch p := payload.(type) {
	case exportPayload:
		if err := q.prepExport(t, p); err != nil {
			return "", err
		}
		t.Kind, t.Lane, timeout = kindExport, laneRender, exportTimeout
	case generatePayload:
		if err := q.prepGenerate(t, p); err != nil {
			return "", err
		}
		t.Kind, t.Lane, timeout = kindGenerate, lanePlugin, generateTimeout
	case rerenderPayload:
		if err := q.prepRerender(t, p); err != nil {
			return "", err
		}
		t.Kind, t.Lane, timeout = kindRerender, lanePlugin, generateTimeout
	case transcribePayload:
		t.Kind, t.Lane, timeout = kindTranscribe, laneTranscribe, transcribeTimeout
	default:
		return "", fmt.Errorf("unknown task payload %T", payload)
	}

	ch, ok := q.lanes[t.Lane]
	if !ok {
		return "", fmt.Errorf("no workers for lane %q", t.Lane)
	}
	t.job = q.srv.Jobs.NewQueued(t.Kind, timeout)
	q.remember(t)
	ch <- t
	return t.job.ID, nil
}

// Retry re-runs a previously-submitted task as a fresh job with the same inputs.
// Re-running Enqueue (rather than replaying the resolved task) means a retried
// export gets a new output path and a retried generate a new asset, while a
// retried re-render still targets its original asset.
func (q *workQueue) Retry(jobID string) (string, error) {
	q.mu.Lock()
	t, ok := q.tasks[jobID]
	q.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("unknown or expired job")
	}
	return q.Enqueue(t.Payload)
}

// remember stores a task's inputs for Retry, evicting oldest-first past the cap.
func (q *workQueue) remember(t *task) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks[t.job.ID] = t
	q.order = append(q.order, t.job.ID)
	for len(q.order) > taskHistoryCap {
		delete(q.tasks, q.order[0])
		q.order = q.order[1:]
	}
}

// run executes one task and reports its terminal state on the job.
func (q *workQueue) run(t *task) {
	job := t.job
	// Canceled while waiting in the queue — don't start it.
	if err := job.Context().Err(); err != nil {
		job.Fail(err)
		return
	}
	job.Begin()

	var (
		data any
		err  error
	)
	switch p := t.Payload.(type) {
	case exportPayload:
		data, err = q.runExport(t, p)
	case generatePayload:
		data, err = q.runGenerate(t, p)
	case rerenderPayload:
		data, err = q.runRerender(t, p)
	case transcribePayload:
		data, err = q.runTranscribe(t, p)
	default:
		err = fmt.Errorf("unknown task payload %T", t.Payload)
	}
	if err != nil {
		job.Fail(err)
		return
	}
	job.Done(data)
}

// ---- export ----

// prepExport allocates the output path and compiles the filtergraph, so bad
// options (e.g. an out-of-range trim) fail the enqueue call.
func (q *workQueue) prepExport(t *task, p exportPayload) error {
	resolve := func(assetID string) (string, bool) {
		for _, a := range p.Doc.Assets {
			if a.ID == assetID {
				return q.srv.Store.Abs(a.Path), true
			}
		}
		return "", false
	}
	renders, err := q.srv.Store.RendersDir(p.ProjID)
	if err != nil {
		return err
	}
	ext := p.Opts.Format
	if ext == "" {
		ext = "mp4"
	}
	if p.Opts.LUTDir == "" {
		p.Opts.LUTDir, _ = q.srv.Store.LutsDir(p.ProjID)
	}
	t.outPath = filepath.Join(renders, "export-"+store.NewID("")+"."+ext)
	t.plan, err = render.Compile(p.Doc, resolve, t.outPath, renders, p.Opts)
	return err
}

func (q *workQueue) runExport(t *task, p exportPayload) (any, error) {
	job := t.job
	job.Progress(0.02, "rendering")
	if err := render.Run(job.Context(), job, t.plan); err != nil {
		return nil, err
	}
	asset, err := q.srv.registerAsset(job.Context(), p.ProjID, store.NewID("asset_"),
		t.outPath, "Export "+filepath.Base(t.outPath), "export")
	if err != nil {
		return nil, err
	}
	if _, err := q.srv.Store.AddAsset(p.ProjID, *asset); err != nil {
		return nil, err
	}
	return map[string]any{"asset": asset, "url": "/media/" + q.srv.Store.Rel(t.outPath)}, nil
}

// ---- generation ----

func (q *workQueue) prepGenerate(t *task, p generatePayload) error {
	adapter, ok := q.srv.Gens.Get(p.GeneratorID)
	if !ok {
		return fmt.Errorf("unknown generator %q", p.GeneratorID)
	}
	dir, err := q.srv.Store.AssetsDir(p.ProjID)
	if err != nil {
		return err
	}
	// A generator exposing a --format param writes that container, not its
	// default OutputExt — name the file accordingly or ffprobe/browsers choke.
	ext := adapter.OutputExt
	for _, spec := range adapter.Params {
		if spec.Flag == "--format" {
			if v := p.Params["--format"]; v != "" {
				ext = v
			}
			break
		}
	}
	t.assetID = store.NewID("asset_")
	t.outPath = filepath.Join(dir, t.assetID+"."+ext)
	return nil
}

func (q *workQueue) runGenerate(t *task, p generatePayload) (any, error) {
	job := t.job
	adapter, ok := q.srv.Gens.Get(p.GeneratorID)
	if !ok {
		return nil, fmt.Errorf("unknown generator %q", p.GeneratorID)
	}
	ctx := job.Context()
	job.Progress(0.05, "starting "+adapter.Name)
	if err := q.srv.Gens.Generate(ctx, job, p.GeneratorID, p.Input, p.Params, t.outPath); err != nil {
		return nil, err
	}
	job.Progress(0.9, "registering clip")
	asset, err := q.srv.registerAsset(ctx, p.ProjID, t.assetID, t.outPath, adapter.Name+" clip", p.GeneratorID)
	if err != nil {
		return nil, err
	}
	// Keep the generation "live": remember the input + params so the clip can be
	// re-rendered later from the studio inspector.
	asset.GenInput = p.Input
	asset.GenParams = p.Params
	if _, err := q.srv.Store.AddAsset(p.ProjID, *asset); err != nil {
		return nil, err
	}
	return map[string]any{"asset": asset}, nil
}

// prepRerender resolves the existing asset's media path — re-render overwrites it
// in place so the asset's Path stays valid and no orphan file is left behind.
func (q *workQueue) prepRerender(t *task, p rerenderPayload) error {
	if _, ok := q.srv.Gens.Get(p.Source); !ok {
		return fmt.Errorf("asset %q was not produced by a known generator", p.AssetID)
	}
	doc, err := q.srv.Store.GetProject(p.ProjID)
	if err != nil {
		return err
	}
	for i := range doc.Assets {
		if doc.Assets[i].ID == p.AssetID {
			t.assetID = p.AssetID
			t.outPath = q.srv.Store.Abs(doc.Assets[i].Path)
			return nil
		}
	}
	return fmt.Errorf("unknown asset %q", p.AssetID)
}

func (q *workQueue) runRerender(t *task, p rerenderPayload) (any, error) {
	job := t.job
	adapter, ok := q.srv.Gens.Get(p.Source)
	if !ok {
		return nil, fmt.Errorf("unknown generator %q", p.Source)
	}
	ctx := job.Context()
	job.Progress(0.05, "re-rendering "+adapter.Name)
	if err := q.srv.Gens.Generate(ctx, job, p.Source, p.Input, p.Params, t.outPath); err != nil {
		return nil, err
	}
	job.Progress(0.9, "updating clip")
	asset, err := q.srv.registerAsset(ctx, p.ProjID, t.assetID, t.outPath, p.Name, p.Source)
	if err != nil {
		return nil, err
	}
	asset.GenInput = p.Input
	asset.GenParams = p.Params
	if _, err := q.srv.Store.UpdateAsset(p.ProjID, *asset); err != nil {
		return nil, err
	}
	return map[string]any{"asset": asset}, nil
}

// ---- transcription ----

func (q *workQueue) runTranscribe(t *task, p transcribePayload) (any, error) {
	job := t.job
	job.Progress(0.1, "extracting audio")
	work, err := os.MkdirTemp("", "studio-transcribe-*") // isolated scratch (avoids clobbering concurrent jobs)
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)
	cues, err := transcribe.Transcribe(job.Context(), q.srv.Store.Abs(p.SrcRel), work)
	if err != nil {
		return nil, err
	}
	return map[string]any{"cues": cues}, nil
}
