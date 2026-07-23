package render

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// audibleSource writes a real file with an audio stream — Compile probes its
// inputs and silently drops audio contributions it cannot find a stream in,
// so a made-up path would test nothing.
func audibleSource(t *testing.T, dir string, video bool) string {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	var cmd *exec.Cmd
	var path string
	if video {
		path = filepath.Join(dir, "av.mp4")
		cmd = exec.Command("ffmpeg", "-y", "-loglevel", "error",
			"-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=2",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
			"-c:v", "libx264", "-c:a", "aac", "-shortest", path)
	} else {
		path = filepath.Join(dir, "tone.wav")
		cmd = exec.Command("ffmpeg", "-y", "-loglevel", "error",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=2", path)
	}
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build audible source: %v\n%s", err, b)
	}
	return path
}

func compileWith(t *testing.T, doc *schema.EditDoc, src string) string {
	t.Helper()
	plan, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(t.TempDir(), "o.mp4"), t.TempDir(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	return strings.Join(plan.Args, " ")
}

func audioDoc(denoise float64, eq *schema.AudioEQ) *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "au", Kind: schema.TrackAudio, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2, Denoise: denoise, EQ: eq,
		}}}},
	}
}

func TestDenoiseCompilesToAfftdn(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	args := compileWith(t, audioDoc(0.5, nil), src)
	// 0.5 strength → 15dB of reduction against a -33.5dB floor.
	if !strings.Contains(args, "afftdn=nr=15.0:nf=-33.5") {
		t.Errorf("denoise 0.5 did not compile to afftdn=nr=15.0:nf=-33.5:\n%s", args)
	}
	// And it judges the source's own floor: denoise precedes the volume gain.
	if strings.Index(args, "afftdn") > strings.Index(args, "volume=") {
		t.Error("denoise runs after the volume gain; it must see the raw source")
	}
}

func TestDenoiseAppliesToAVideoClipsOwnAudio(t *testing.T) {
	// Narration is often recorded INTO the screen capture, so the field has to
	// work on a video clip's embedded audio, not just audio-track clips.
	dir := t.TempDir()
	src := audibleSource(t, dir, true)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2, Denoise: 1,
		}}}},
	}
	if args := compileWith(t, doc, src); !strings.Contains(args, "afftdn=nr=27.0:nf=-22.0") {
		t.Errorf("denoise on a video clip's audio did not compile:\n%s", args)
	}
}

func TestNoDenoiseMeansNoFilter(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	if args := compileWith(t, audioDoc(0, nil), src); strings.Contains(args, "afftdn") {
		t.Error("a clip without Denoise grew an afftdn filter")
	}
}

// A video clip's EQ used to be silently dropped — only audio-track clips passed
// it through. Fixed alongside denoise; this pins the field on the video path.
func TestVideoClipEQIsHonored(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, true)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			EQ: &schema.AudioEQ{Low: 3},
		}}}},
	}
	if args := compileWith(t, doc, src); !strings.Contains(args, "bass=g=3.00") {
		t.Error("EQ on a video clip's own audio is still being dropped")
	}
}

// The whole point, end to end: a noisy narration measurably quiets down while
// speech-band content survives. White noise + a 440Hz tone stand in for hiss +
// voice; the reduction should strip far more of the broadband floor than of
// the tone.
func TestDenoiseActuallyReducesNoise(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "noisy.wav")
	// A tone over a noticeable noise floor.
	mk := exec.Command("ffmpeg", "-y", "-loglevel", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:duration=2",
		"-f", "lavfi", "-i", "anoisesrc=colour=white:amplitude=0.08:duration=2",
		"-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0[a]", "-map", "[a]", src)
	if b, err := mk.CombinedOutput(); err != nil {
		t.Fatalf("build noisy source: %v\n%s", err, b)
	}

	rms := func(denoise float64) float64 {
		out := filepath.Join(dir, fmt.Sprintf("out-%.1f.mp4", denoise))
		doc := audioDoc(denoise, nil)
		plan, err := Compile(doc, func(string) (string, bool) { return src, true }, out, t.TempDir(), Options{})
		if err != nil {
			t.Fatal(err)
		}
		if b, err := exec.Command("ffmpeg", plan.Args...).CombinedOutput(); err != nil {
			t.Fatalf("ffmpeg: %v\n%s", err, b)
		}
		// astats overall RMS level in dB.
		an := exec.Command("ffmpeg", "-i", out, "-af", "astats=metadata=1", "-f", "null", "-")
		b, _ := an.CombinedOutput()
		s := string(b)
		i := strings.LastIndex(s, "RMS level dB:")
		if i < 0 {
			t.Fatalf("no RMS in astats output:\n%s", s)
		}
		var v float64
		fmt.Sscanf(s[i:], "RMS level dB: %f", &v)
		return v
	}

	raw := rms(0)
	cleaned := rms(1)
	/*
	 * The bounds are the mix's arithmetic, measured before they were written:
	 * tone -21.1dB, noise -26.7dB, mix -20.0dB. Removing ALL the noise lands
	 * the mix on the tone alone — a ~1.1dB drop in overall RMS — while killing
	 * the tone too would fall several dB further. So >0.7dB of drop means the
	 * floor genuinely went, and <3dB means the signal genuinely stayed. (This
	 * is the test that caught tn=1 doing nothing: 0.06dB.)
	 */
	if cleaned > raw-0.7 {
		t.Errorf("denoise removed almost nothing: raw %.1fdB → cleaned %.1fdB", raw, cleaned)
	}
	if cleaned < raw-3 {
		t.Errorf("denoise stripped the signal too: raw %.1fdB → cleaned %.1fdB", raw, cleaned)
	}
}
