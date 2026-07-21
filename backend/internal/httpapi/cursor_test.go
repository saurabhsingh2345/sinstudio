package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validCursorJSON(t *testing.T) string {
	t.Helper()
	c := CursorTrack{Version: 1, Clicks: true, Samples: []CursorSample{
		{T: 0, X: 10, Y: 20},
		{T: 16, X: 12, Y: 22, Down: 1},
	}}
	c.Video.Width, c.Video.Height = 1920, 1080
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCursorPathSitsBesideTheMedia(t *testing.T) {
	if got := cursorPath("/m/clip.mp4"); got != "/m/clip.cursor.json" {
		t.Errorf("cursorPath = %q", got)
	}
	// A recording is WebM; the suffix must not stack onto the old extension.
	if got := cursorPath("/m/screen.webm"); got != "/m/screen.cursor.json" {
		t.Errorf("cursorPath = %q", got)
	}
}

func TestParseCursorTrackRejectsUnusableData(t *testing.T) {
	good := validCursorJSON(t)
	if _, err := parseCursorTrack(good); err != nil {
		t.Fatalf("valid track rejected: %v", err)
	}

	for name, raw := range map[string]string{
		"not json":        `{nope`,
		"missing version": `{"video":{"width":1,"height":1},"samples":[{"t":0,"x":0,"y":0}]}`,
		// Without the frame the coordinates were mapped into, the samples are
		// unplaceable — storing them would look like data and behave like noise.
		"no video dims": `{"version":1,"samples":[{"t":0,"x":0,"y":0}]}`,
		"zero width":    `{"version":1,"video":{"width":0,"height":1080},"samples":[{"t":0,"x":0,"y":0}]}`,
		"no samples":    `{"version":1,"video":{"width":1920,"height":1080},"samples":[]}`,
	} {
		if _, err := parseCursorTrack(raw); err == nil {
			t.Errorf("%s: expected a rejection", name)
		}
	}
}

func TestCursorTrackRoundTrips(t *testing.T) {
	dir := t.TempDir()
	mediaPath := filepath.Join(dir, "screen.webm")
	if err := os.WriteFile(mediaPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	in, err := parseCursorTrack(validCursorJSON(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeCursorTrack(mediaPath, in); err != nil {
		t.Fatal(err)
	}
	out, err := readCursorTrack(mediaPath)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if out == nil {
		t.Fatal("sidecar not found after writing it")
	}
	if len(out.Samples) != 2 || out.Samples[1].Down != 1 || !out.Clicks {
		t.Fatalf("round trip lost data: %+v", out)
	}
	if out.Video.Width != 1920 {
		t.Fatalf("round trip lost video dims: %+v", out.Video)
	}
}

// Most clips are not screen recordings; having no cursor data is the norm and
// must not read as an error.
func TestMissingCursorSidecarIsNormal(t *testing.T) {
	dir := t.TempDir()
	mediaPath := filepath.Join(dir, "plain.mp4")
	if err := os.WriteFile(mediaPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := readCursorTrack(mediaPath)
	if err != nil {
		t.Fatalf("missing sidecar reported an error: %v", err)
	}
	if got != nil {
		t.Fatalf("expected no track, got %+v", got)
	}
}

// The recording is the valuable part. Bad cursor data is reported, and the clip
// still lands — the same trade provenance makes.
func TestIngestKeepsTheRecordingWhenCursorDataIsBad(t *testing.T) {
	data := streamedWebM(t, "1")
	s := testServer(t, "")
	h := s.Routes()

	w := postFileFields(t, h, "/api/ingest", "screen.webm", data, map[string]string{
		"source":   "recording-screen",
		"streamed": "1",
		"cursor":   `{"version":1,"video":{"width":0,"height":0},"samples":[]}`,
	})
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if msg, _ := got["cursorError"].(string); msg == "" {
		t.Error("bad cursor data should be reported")
	}
	if ok, _ := got["ok"].(bool); !ok {
		t.Error("the recording should still have landed")
	}
	if inbox, _ := got["inbox"].(string); inbox == "" {
		t.Error("the recording should still be in the inbox")
	}
	// And no half-written sidecar left behind.
	matches, _ := filepath.Glob(filepath.Join(s.Store.Root(), "inbox", "*.cursor.json"))
	if len(matches) > 0 {
		t.Errorf("a rejected sidecar was written anyway: %v", matches)
	}
}

func TestIngestStoresCursorDataBesideTheRecording(t *testing.T) {
	data := streamedWebM(t, "1")
	s := testServer(t, "")
	h := s.Routes()

	w := postFileFields(t, h, "/api/ingest", "screen.webm", data, map[string]string{
		"source":   "recording-screen",
		"streamed": "1",
		"cursor":   validCursorJSON(t),
	})
	var got map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if msg, _ := got["cursorError"].(string); msg != "" {
		t.Fatalf("cursor data rejected: %s", msg)
	}
	inbox, _ := got["inbox"].(string)
	stored := filepath.Join(s.Store.Root(), strings.TrimPrefix(inbox, "/"))
	track, err := readCursorTrack(stored)
	if err != nil {
		t.Fatalf("reading the stored sidecar: %v", err)
	}
	if track == nil {
		t.Fatal("no sidecar was written beside the recording")
	}
	if len(track.Samples) != 2 {
		t.Fatalf("stored %d samples, want 2", len(track.Samples))
	}
}
