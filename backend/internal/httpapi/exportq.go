package httpapi

import (
	"fmt"
	"path/filepath"
	"sync"

	"studio/internal/jobs"
	"studio/internal/render"
	"studio/internal/schema"
	"studio/internal/store"
)

// exportReq is a single queued export and the inputs needed to (re)run it.
type exportReq struct {
	projID  string
	doc     *schema.EditDoc
	opts    render.Options
	outPath string
	plan    *render.Plan
	job     *jobs.Job
}

// exportQueue serializes video exports through a bounded worker pool so many
// simultaneous requests can't thrash the machine (each export is a full FFmpeg
// process). Jobs sit in the "queued" state until a worker frees up. It remembers
// each request so a failed/canceled export can be retried verbatim.
type exportQueue struct {
	srv  *Server
	ch   chan *exportReq
	mu   sync.Mutex
	reqs map[string]*exportReq // jobID -> original request
}

// newExportQueue starts `workers` background workers (min 1).
func newExportQueue(srv *Server, workers int) *exportQueue {
	if workers < 1 {
		workers = 1
	}
	q := &exportQueue{srv: srv, ch: make(chan *exportReq, 128), reqs: map[string]*exportReq{}}
	for i := 0; i < workers; i++ {
		go q.worker()
	}
	return q
}

// Enqueue compiles the export (failing fast on bad options) and schedules it,
// returning the queued job's id.
func (q *exportQueue) Enqueue(projID string, doc *schema.EditDoc, opts render.Options) (string, error) {
	resolve := func(assetID string) (string, bool) {
		for _, a := range doc.Assets {
			if a.ID == assetID {
				return q.srv.Store.Abs(a.Path), true
			}
		}
		return "", false
	}
	renders, err := q.srv.Store.RendersDir(projID)
	if err != nil {
		return "", err
	}
	ext := opts.Format
	if ext == "" {
		ext = "mp4"
	}
	outPath := filepath.Join(renders, "export-"+store.NewID("")+"."+ext)
	plan, err := render.Compile(doc, resolve, outPath, renders, opts)
	if err != nil {
		return "", err
	}

	job := q.srv.Jobs.NewQueued("export", exportTimeout)
	req := &exportReq{projID: projID, doc: doc, opts: opts, outPath: outPath, plan: plan, job: job}
	q.mu.Lock()
	q.reqs[job.ID] = req
	q.mu.Unlock()
	q.ch <- req
	return job.ID, nil
}

// Retry re-runs a previously-submitted export (by original job id) as a fresh
// job with the same project/options. Returns the new job id.
func (q *exportQueue) Retry(jobID string) (string, error) {
	q.mu.Lock()
	req, ok := q.reqs[jobID]
	q.mu.Unlock()
	if !ok {
		return "", fmt.Errorf("unknown export job")
	}
	return q.Enqueue(req.projID, req.doc, req.opts)
}

func (q *exportQueue) worker() {
	for req := range q.ch {
		q.run(req)
	}
}

func (q *exportQueue) run(req *exportReq) {
	job := req.job
	// Canceled while waiting in the queue — don't start it.
	if err := job.Context().Err(); err != nil {
		job.Fail(err)
		return
	}
	job.Begin()
	job.Progress(0.02, "rendering")
	if err := render.Run(job.Context(), job, req.plan); err != nil {
		job.Fail(err)
		return
	}
	asset, err := q.srv.registerAsset(job.Context(), req.projID, store.NewID("asset_"),
		req.outPath, "Export "+filepath.Base(req.outPath), "export")
	if err != nil {
		job.Fail(err)
		return
	}
	if _, err := q.srv.Store.AddAsset(req.projID, *asset); err != nil {
		job.Fail(err)
		return
	}
	job.Done(map[string]any{"asset": asset, "url": "/media/" + q.srv.Store.Rel(req.outPath)})
}
