// Package cursor is the pointer track recorded alongside a screen capture:
// where the pointer was and when it was clicked, so the renderer can draw
// highlights and click rings over the footage.
//
// It is stored as a sidecar beside the media, exactly like provenance
// (clip.mp4 → clip.cursor.json). Same reasoning: a sidecar needs no schema
// migration on the asset, survives being copied around, and is trivially
// inspectable when something looks wrong.
//
// The browser writes it from data collected by tools/cursord, already converted
// into the recording's own frame: times are milliseconds from the first video
// frame and coordinates are video pixels. Neither the server nor the renderer
// has to know anything about the display it was captured on.
package cursor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Suffix is appended to the media filename: clip.mp4 → clip.cursor.json.
const Suffix = ".cursor.json"

// MaxBytes caps a sidecar. A 60Hz stream deduped to movement runs well under a
// megabyte for a long recording; far past that is a bug, and reading it on
// every import would be one too.
const MaxBytes = 16 << 20

// Button bits in Sample.Down.
const (
	ButtonLeft  = 1 << 0
	ButtonRight = 1 << 1
)

// Sample is one pointer observation, in the recording's own frame.
type Sample struct {
	T    int64 `json:"t"` // ms from the first video frame
	X    int   `json:"x"`
	Y    int   `json:"y"`
	Down uint8 `json:"down,omitempty"`
}

// Track is the sidecar document.
type Track struct {
	Version int `json:"version"`
	Video   struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"video"`
	// Clicks records whether button state could be observed at all, so a
	// consumer can tell "no clicks happened" from "clicks were never visible".
	Clicks bool `json:"clicks"`
	// Hidden records that the OS cursor was kept OUT of the capture, so the
	// renderer owns drawing it. This has to travel with the recording rather
	// than be a project setting: anything captured before we started hiding it
	// has a cursor burned into the pixels, and drawing a second one over that
	// is the one outcome worse than not drawing any.
	Hidden  bool     `json:"hidden,omitempty"`
	Samples []Sample `json:"samples"`
}

// Path returns the sidecar path for a media file.
func Path(mediaPath string) string {
	return strings.TrimSuffix(mediaPath, filepath.Ext(mediaPath)) + Suffix
}

// Parse validates a sidecar document.
func Parse(raw string) (*Track, error) {
	if len(raw) > MaxBytes {
		return nil, fmt.Errorf("cursor data is %d bytes, over the %d limit", len(raw), MaxBytes)
	}
	var c Track
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, fmt.Errorf("cursor field: %w", err)
	}
	if c.Version == 0 {
		return nil, fmt.Errorf("cursor field: missing version")
	}
	if c.Video.Width <= 0 || c.Video.Height <= 0 {
		// Without the frame the samples were mapped into, the coordinates mean
		// nothing — better to refuse than store a set of unplaceable points.
		return nil, fmt.Errorf("cursor field: missing video dimensions")
	}
	if len(c.Samples) == 0 {
		return nil, fmt.Errorf("cursor field: no samples")
	}
	return &c, nil
}

// Write stores the sidecar beside a media file.
func Write(mediaPath string, c *Track) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(Path(mediaPath), data, 0o644)
}

// Read loads the sidecar beside a media file, if there is one. A missing
// sidecar is not an error: most clips have no cursor data, and the ones that do
// are the exception.
func Read(mediaPath string) (*Track, error) {
	path := Path(mediaPath)
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil
	}
	if info.Size() > MaxBytes {
		return nil, fmt.Errorf("%s is %d bytes, over the %d limit", filepath.Base(path), info.Size(), MaxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(string(data))
}

// ClickTimes returns the moment each press begins, in seconds from the clip's
// first frame. Only the edges count: a button held down is one click, not one
// per sample, and a ring drawn per sample would strobe.
func (t *Track) ClickTimes() []float64 {
	var out []float64
	var prev uint8
	for _, s := range t.Samples {
		if s.Down != 0 && prev == 0 {
			out = append(out, float64(s.T)/1000)
		}
		prev = s.Down
	}
	return out
}

// At returns the pointer position at ts (seconds from the clip's first frame),
// holding the nearest sample outside the recorded range.
func (t *Track) At(ts float64) (int, int) {
	if len(t.Samples) == 0 {
		return 0, 0
	}
	ms := int64(ts * 1000)
	if ms <= t.Samples[0].T {
		return t.Samples[0].X, t.Samples[0].Y
	}
	last := t.Samples[len(t.Samples)-1]
	if ms >= last.T {
		return last.X, last.Y
	}
	for i := 0; i < len(t.Samples)-1; i++ {
		a, b := t.Samples[i], t.Samples[i+1]
		if ms < b.T {
			// Linear between samples. The sampler already collapsed the spans
			// where nothing moved, so this interpolates motion, not stillness.
			span := float64(b.T - a.T)
			if span <= 0 {
				return a.X, a.Y
			}
			f := float64(ms-a.T) / span
			return a.X + int(float64(b.X-a.X)*f), a.Y + int(float64(b.Y-a.Y)*f)
		}
	}
	return last.X, last.Y
}
