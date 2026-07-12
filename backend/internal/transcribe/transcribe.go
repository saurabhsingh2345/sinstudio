// Package transcribe produces caption cues from an asset's audio using
// whisper.cpp (the `whisper-cli` binary). It is optional: if the binary or
// model is missing, Transcribe returns a helpful error the UI can surface.
package transcribe

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"studio/internal/schema"
	"studio/internal/store"
)

// Binary/model can be overridden via env for flexibility.
func binary() string {
	if b := os.Getenv("WHISPER_BIN"); b != "" {
		return b
	}
	return "whisper-cli"
}

func model() string {
	if m := os.Getenv("WHISPER_MODEL"); m != "" {
		return m
	}
	return "" // must be provided; error surfaced below
}

func defaultStyle() schema.CaptionStyle {
	return schema.CaptionStyle{Font: "Inter", Size: 24, Color: "#ffffff", Align: "center", PosY: 0.85}
}

// Available reports whether whisper.cpp appears usable.
func Available() error {
	if _, err := exec.LookPath(binary()); err != nil {
		return fmt.Errorf("whisper binary %q not found (set WHISPER_BIN)", binary())
	}
	if model() == "" {
		return fmt.Errorf("no whisper model configured (set WHISPER_MODEL to a ggml .bin)")
	}
	if _, err := os.Stat(model()); err != nil {
		return fmt.Errorf("whisper model missing: %s", model())
	}
	return nil
}

// Transcribe extracts mono 16kHz audio from src and runs whisper.cpp, returning
// timed cues. It writes intermediate files under workDir.
func Transcribe(ctx context.Context, src, workDir string) ([]schema.CaptionCue, error) {
	if err := Available(); err != nil {
		return nil, err
	}
	wav := filepath.Join(workDir, "audio-16k.wav")
	extract := exec.CommandContext(ctx, "ffmpeg", "-y", "-loglevel", "error",
		"-i", src, "-ac", "1", "-ar", "16000", "-vn", wav)
	if out, err := extract.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("extract audio: %v: %s", err, string(out))
	}
	outBase := filepath.Join(workDir, "captions")
	// whisper.cpp: -osrt writes <outBase>.srt
	cmd := exec.CommandContext(ctx, binary(), "-m", model(), "-f", wav, "-osrt", "-of", outBase)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("whisper: %v: %s", err, string(out))
	}
	return parseSRT(outBase + ".srt")
}

// parseSRT reads a SubRip file into caption cues.
func parseSRT(path string) ([]schema.CaptionCue, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var cues []schema.CaptionCue
	sc := bufio.NewScanner(f)
	var cur *schema.CaptionCue
	var textLines []string
	flush := func() {
		if cur != nil {
			cur.Text = strings.TrimSpace(strings.Join(textLines, " "))
			if cur.Text != "" {
				cues = append(cues, *cur)
			}
		}
		cur, textLines = nil, nil
	}
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			flush()
			continue
		}
		if strings.Contains(line, "-->") {
			parts := strings.SplitN(line, "-->", 2)
			cur = &schema.CaptionCue{
				ID:    store.NewID("cue_"),
				Start: parseSRTTime(parts[0]),
				End:   parseSRTTime(parts[1]),
				Style: defaultStyle(),
			}
			continue
		}
		if cur == nil {
			continue // sequence number
		}
		textLines = append(textLines, line)
	}
	flush()
	return cues, nil
}

// parseSRTTime parses "HH:MM:SS,mmm" into seconds.
func parseSRTTime(s string) float64 {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, ",", ".")
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return 0
	}
	h, _ := strconv.ParseFloat(parts[0], 64)
	m, _ := strconv.ParseFloat(parts[1], 64)
	sec, _ := strconv.ParseFloat(parts[2], 64)
	return h*3600 + m*60 + sec
}
