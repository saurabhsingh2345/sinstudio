package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/media"
)

// streamedWebM produces a container with the same defect a browser recording
// has. MediaRecorder writes its output as a stream and can never seek back to
// finish the header, so piping ffmpeg's output through stdout reproduces it
// exactly: no duration, no cues.
func streamedWebM(t *testing.T, seconds string) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	cmd := exec.Command("ffmpeg", "-v", "error",
		"-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:d="+seconds,
		"-c:v", "libvpx", "-b:v", "120k", "-f", "webm", "-")
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if err := cmd.Run(); err != nil {
		t.Skipf("could not build a streamed webm: %v", err)
	}
	if buf.Len() == 0 {
		t.Skip("empty webm fixture")
	}
	return buf.Bytes()
}

func probeDuration(t *testing.T, path string) string {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error",
		"-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	return strings.TrimSpace(string(out))
}

// ingestFile uploads one recording and returns the decoded response.
func ingestFile(t *testing.T, h http.Handler, url, filename string, data []byte) map[string]any {
	t.Helper()
	w := postFile(h, url, "file", filename, data)
	if w.Code != 200 {
		t.Fatalf("ingest = %d: %s", w.Code, w.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode ingest response: %v (%s)", err, w.Body.String())
	}
	return got
}

// TestStreamedWebMArrivesUnmeasurable documents the defect being fixed. If this
// ever starts failing, browsers began writing a usable header and the repair on
// ingest can be reconsidered.
func TestStreamedWebMArrivesUnmeasurable(t *testing.T) {
	data := streamedWebM(t, "2")
	raw := filepath.Join(t.TempDir(), "raw.webm")
	if err := os.WriteFile(raw, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if d := probeDuration(t, raw); d != "N/A" && d != "" {
		t.Fatalf("expected an unmeasurable streamed webm, got duration %q", d)
	}
}

// TestIngestRepairsStreamedRecording is the property that matters: a recording
// uploaded straight from the browser must land as a clip the timeline can
// measure and the preview can scrub, not one of unknown length.
func TestIngestRepairsStreamedRecording(t *testing.T) {
	data := streamedWebM(t, "2")
	s := testServer(t, "")
	h := s.Routes()

	got := ingestFile(t, h, "/api/ingest", "screen.webm", data)
	if msg, _ := got["remuxError"].(string); msg != "" {
		t.Fatalf("remux reported an error: %s", msg)
	}
	inbox, _ := got["inbox"].(string)
	if inbox == "" {
		t.Fatalf("no inbox path in response: %v", got)
	}
	stored := filepath.Join(s.Store.Root(), strings.TrimPrefix(inbox, "/"))
	if _, err := os.Stat(stored); err != nil {
		// Rel() may already be root-relative; fall back to a search of the inbox.
		matches, _ := filepath.Glob(filepath.Join(s.Store.Root(), "inbox", "*.webm"))
		if len(matches) == 0 {
			t.Fatalf("stored recording not found (inbox=%q): %v", inbox, err)
		}
		stored = matches[0]
	}

	d := probeDuration(t, stored)
	if d == "N/A" || d == "" {
		t.Fatalf("ingested recording still has no duration — it would land as an unmeasurable clip")
	}
}

// TestRemuxIsLossless guards the choice of -c copy over a re-encode: repairing a
// recording must not degrade it. Byte size is a good enough proxy — a re-encode
// at any sane setting moves it substantially.
func TestRemuxIsLossless(t *testing.T) {
	data := streamedWebM(t, "2")
	dir := t.TempDir()
	src := filepath.Join(dir, "in.webm")
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := media.RemuxInPlace(t.Context(), src); err != nil {
		t.Fatalf("remux: %v", err)
	}
	fi, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	ratio := float64(fi.Size()) / float64(len(data))
	if ratio < 0.9 || ratio > 1.1 {
		t.Errorf("remux changed size by more than 10%% (%d -> %d) — is it re-encoding?", len(data), fi.Size())
	}
}

// TestRemuxFailureLeavesTheUploadIntact pins the safety rule: a repair that
// fails must not consume the file. An unseekable recording is a poor clip; a
// deleted one is no clip at all.
func TestRemuxFailureLeavesTheUploadIntact(t *testing.T) {
	dir := t.TempDir()
	junk := filepath.Join(dir, "not-really.webm")
	original := []byte("this is not a media file")
	if err := os.WriteFile(junk, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := media.RemuxInPlace(t.Context(), junk); err == nil {
		t.Fatal("expected a remux error for a non-media file")
	}
	got, err := os.ReadFile(junk)
	if err != nil {
		t.Fatalf("original was consumed by a failed remux: %v", err)
	}
	if !bytes.Equal(got, original) {
		t.Fatalf("original was modified by a failed remux: %q", got)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "*.remux*")); len(leftovers) > 0 {
		t.Errorf("failed remux left a temporary file behind: %v", leftovers)
	}
}

// TestNeedsRemuxOnlyTargetsStreamedContainers keeps the repair off files that
// already have a usable header — an mp4 import should not be rewritten.
func TestNeedsRemuxOnlyTargetsStreamedContainers(t *testing.T) {
	for path, want := range map[string]bool{
		"/x/rec.webm": true, "/x/REC.WEBM": true,
		"/x/clip.mp4": false, "/x/clip.mov": false, "/x/audio.wav": false,
	} {
		if got := media.NeedsRemux(path); got != want {
			t.Errorf("NeedsRemux(%q) = %v, want %v", path, got, want)
		}
	}
}
