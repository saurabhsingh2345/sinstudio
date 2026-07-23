package render

import (
	"bytes"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"studio/internal/cursor"
	"studio/internal/schema"
)

func clickTrack(times ...float64) *cursor.Track {
	var tr cursor.Track
	tr.Video.Width, tr.Video.Height = 1920, 1080
	tr.Clicks = true
	// A release between presses, or the next press is not an edge.
	t := int64(0)
	for _, ct := range times {
		ms := int64(ct * 1000)
		tr.Samples = append(tr.Samples,
			cursor.Sample{T: ms, X: 10, Y: 10, Down: cursor.ButtonLeft},
			cursor.Sample{T: ms + 60, X: 10, Y: 10})
		t = ms
	}
	_ = t
	return &tr
}

// samplePeaks returns the loudest absolute level in each 10ms bucket, for
// locating transients in the rendered PCM.
func samplePeaks(t *testing.T, path string) []float64 {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(b, []byte("RIFF")) {
		t.Fatal("not a RIFF file")
	}
	pcm := b[44:]
	const bucket = clickSampleRate / 100 // 10ms
	out := make([]float64, len(pcm)/2/bucket+1)
	for i := 0; i+1 < len(pcm); i += 2 {
		v := math.Abs(float64(int16(binary.LittleEndian.Uint16(pcm[i:])))) / 32767
		b := i / 2 / bucket
		if b < len(out) && v > out[b] {
			out[b] = v
		}
	}
	return out
}

// A render that produces different audio each time cannot be cached by content,
// and this project already has one generator with exactly that problem.
func TestClickSoundIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.wav")
	b := filepath.Join(dir, "b.wav")
	tr := clickTrack(0.5, 1.5, 2.5)

	if _, err := writeClickWAV(a, tr, 4, 0, 4, 1, "click", 0.5); err != nil {
		t.Fatal(err)
	}
	if _, err := writeClickWAV(b, tr, 4, 0, 4, 1, "click", 0.5); err != nil {
		t.Fatal(err)
	}
	ab, _ := os.ReadFile(a)
	bb, _ := os.ReadFile(b)
	if !bytes.Equal(ab, bb) {
		t.Error("two renders of the same clicks produced different audio")
	}
}

// Clicks have to land where the presses were, or the sound drifts off the
// action it is meant to punctuate.
func TestClicksLandOnThePresses(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.wav")
	n, err := writeClickWAV(p, clickTrack(0.5, 1.5, 2.5), 4, 0, 4, 1, "click", 0.8)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("wrote %d clicks, want 3", n)
	}
	peaks := samplePeaks(t, p)
	loud := func(sec float64) bool {
		b := int(sec * 100)
		for i := b - 1; i <= b+1 && i < len(peaks); i++ {
			if i >= 0 && peaks[i] > 0.1 {
				return true
			}
		}
		return false
	}
	for _, ct := range []float64{0.5, 1.5, 2.5} {
		if !loud(ct) {
			t.Errorf("no transient at %.1fs", ct)
		}
	}
	// And silence where nothing happened.
	for _, quiet := range []float64{0.1, 1.0, 2.0, 3.5} {
		if loud(quiet) {
			t.Errorf("unexpected sound at %.1fs", quiet)
		}
	}
}

// A held button is one click. Without edge detection a 1s press at 60Hz would
// emit sixty transients — a buzz, not a click.
func TestHeldButtonIsOneClick(t *testing.T) {
	var tr cursor.Track
	tr.Video.Width, tr.Video.Height = 1920, 1080
	for i := 0; i < 60; i++ {
		tr.Samples = append(tr.Samples, cursor.Sample{T: int64(i * 16), X: 5, Y: 5, Down: cursor.ButtonLeft})
	}
	p := filepath.Join(t.TempDir(), "held.wav")
	n, err := writeClickWAV(p, &tr, 3, 0, 3, 1, "click", 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("a held button produced %d clicks, want 1", n)
	}
}

// No presses means no track at all, rather than a silent input padding the mix.
func TestNoClicksWritesNothing(t *testing.T) {
	var tr cursor.Track
	tr.Samples = []cursor.Sample{{T: 0, X: 1, Y: 1}, {T: 500, X: 2, Y: 2}}
	p := filepath.Join(t.TempDir(), "none.wav")
	n, err := writeClickWAV(p, &tr, 3, 0, 3, 1, "click", 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("wrote %d clicks for a track with no presses", n)
	}
}

func TestClicksRespectTrimIn(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "trim.wav")
	// Source click at 1.5s with 1s trim-in → clip-local 0.5s.
	n, err := writeClickWAV(p, clickTrack(1.5), 3, 1, 4, 1, "click", 0.8)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("wrote %d clicks, want 1", n)
	}
	peaks := samplePeaks(t, p)
	loud := func(sec float64) bool {
		b := int(sec * 100)
		for i := b - 1; i <= b+1 && i < len(peaks); i++ {
			if i >= 0 && peaks[i] > 0.1 {
				return true
			}
		}
		return false
	}
	if !loud(0.5) {
		t.Error("click at source 1.5s with in=1 should land at clip-local 0.5s")
	}
	if loud(1.5) {
		t.Error("click should not land at source time in clip-local buffer")
	}
}

func TestClickStylesDifferAndFallBack(t *testing.T) {
	dir := t.TempDir()
	seen := map[string][]byte{}
	for _, style := range []string{"click", "tick", "soft", "nonsense"} {
		p := filepath.Join(dir, style+".wav")
		if _, err := writeClickWAV(p, clickTrack(0.5), 2, 0, 2, 1, style, 0.6); err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(p)
		seen[style] = b
	}
	if bytes.Equal(seen["click"], seen["tick"]) || bytes.Equal(seen["click"], seen["soft"]) {
		t.Error("styles should sound different")
	}
	// An unknown style is a typo, not a reason to render silence.
	if !bytes.Equal(seen["click"], seen["nonsense"]) {
		t.Error("an unknown style should fall back to the default")
	}
}

// ffmpeg has to accept the generated WAV and mix it — a malformed header only
// surfaces there.
func TestClickSoundMixesIntoAnExport(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "a.mp4")
	makeTestClip(t, src, "green")
	writeTrackHidden(t, src, 640, 360, samplePath(), true)

	out := filepath.Join(dir, "out.mp4")
	plan, err := Compile(cursorDoc(&schema.CursorFX{Sound: &schema.CursorClickSound{Volume: 0.6}}), func(string) (string, bool) { return src, true }, out, dir, Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg failed: %v\n%s", err, lastLines(string(b), 8))
	}
	// The output must actually carry an audio stream.
	probe, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "a",
		"-show_entries", "stream=codec_type", "-of", "csv=p=0", out).Output()
	if len(bytes.TrimSpace(probe)) == 0 {
		t.Error("export has no audio stream — the click track was not mixed in")
	}
}
