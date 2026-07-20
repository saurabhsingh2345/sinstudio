package jobs

import (
	"context"
	"testing"
	"time"
)

// TestJobLifecycle covers Get and the terminal-state transitions so a client
// polling GET /api/jobs/{id} sees a correct final status.
func TestJobLifecycle(t *testing.T) {
	m := NewManager()
	j := m.New("export", 0)

	got, ok := m.Get(j.ID)
	if !ok || got.Status != "running" {
		t.Fatalf("expected a running job, got ok=%v status=%q", ok, got.Status)
	}

	j.Done(map[string]any{"x": 1})
	got, _ = m.Get(j.ID)
	if got.Status != "done" || got.Pct != 1 {
		t.Fatalf("expected done/1, got status=%q pct=%v", got.Status, got.Pct)
	}
}

// TestJobCancel confirms Cancel fires the job context (so its subprocess dies)
// and Fail then reports the job as canceled.
func TestJobCancel(t *testing.T) {
	m := NewManager()
	j := m.New("generate", 0)

	if !m.Cancel(j.ID) {
		t.Fatal("Cancel returned false for a known job")
	}
	select {
	case <-j.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("job context was not canceled")
	}
	if j.Context().Err() != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", j.Context().Err())
	}

	j.Fail(j.Context().Err())
	got, _ := m.Get(j.ID)
	if got.Status != "canceled" {
		t.Fatalf("expected canceled status, got %q", got.Status)
	}

	if m.Cancel("nope") {
		t.Fatal("Cancel should return false for an unknown id")
	}
}

// TestJobRetention confirms the registry evicts finished jobs past the cap while
// never dropping a live one, so a long-running server doesn't grow without bound
// but an in-flight export is always still addressable (status, cancel).
func TestJobRetention(t *testing.T) {
	m := NewManager()
	live := m.New("export", 0)

	for i := 0; i < terminalCap+50; i++ {
		m.New("generate", 0).Done(nil)
	}
	// Finished after all the churn — a client polling a just-completed job must
	// still find it.
	recent := m.New("generate", 0)
	recent.Done(nil)

	if _, ok := m.Get(live.ID); !ok {
		t.Fatal("live job was evicted")
	}
	if _, ok := m.Get(recent.ID); !ok {
		t.Fatal("just-finished job was evicted")
	}
	// terminalCap finished + the one live job.
	if n := len(m.List()); n > terminalCap+1 {
		t.Fatalf("registry kept %d jobs, want <= %d", n, terminalCap+1)
	}
}

// TestJobTimeout confirms a timeout deadline fires and Fail labels it timed out.
func TestJobTimeout(t *testing.T) {
	m := NewManager()
	j := m.New("export", 20*time.Millisecond)
	select {
	case <-j.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("job context did not time out")
	}
	if j.Context().Err() != context.DeadlineExceeded {
		t.Fatalf("expected DeadlineExceeded, got %v", j.Context().Err())
	}
	j.Fail(j.Context().Err())
	got, _ := m.Get(j.ID)
	if got.Status != "error" || got.Message != "timed out" {
		t.Fatalf("expected error/'timed out', got status=%q msg=%q", got.Status, got.Message)
	}
}
