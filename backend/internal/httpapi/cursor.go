package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Cursor metadata for a screen recording, stored as a sidecar beside the media
// exactly like provenance (clip.mp4 → clip.cursor.json). Same reasoning: a
// sidecar needs no schema migration on the asset, survives being copied around,
// and is trivially inspectable when something looks wrong.
//
// It is written by the browser from data collected by tools/cursord, already
// converted into the recording's own frame: times are milliseconds from the
// first video frame and coordinates are video pixels. The server does not
// interpret it — it stores it and hands it back — but it does validate the
// shape, because a sidecar that is silently wrong is worse than one refused.

// cursorSuffix is appended to the media filename: clip.mp4 → clip.cursor.json.
const cursorSuffix = ".cursor.json"

// maxCursorBytes caps a sidecar. A 60Hz sample stream deduped to movement runs
// well under a megabyte for a long recording; far past that is a bug, and
// reading it on every import would be one too.
const maxCursorBytes = 16 << 20

// CursorSample is one pointer observation, in the recording's own frame.
type CursorSample struct {
	T    int64 `json:"t"` // ms from the first video frame
	X    int   `json:"x"`
	Y    int   `json:"y"`
	Down uint8 `json:"down,omitempty"` // 1 = left, 2 = right
}

// CursorTrack is the sidecar document.
type CursorTrack struct {
	Version int `json:"version"`
	Video   struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"video"`
	// Clicks records whether button state could be observed at all, so a
	// consumer can tell "no clicks happened" from "clicks were never visible".
	Clicks  bool           `json:"clicks"`
	Samples []CursorSample `json:"samples"`
}

// cursorPath returns the sidecar path for a media file.
func cursorPath(mediaPath string) string {
	return strings.TrimSuffix(mediaPath, filepath.Ext(mediaPath)) + cursorSuffix
}

// parseCursorTrack validates an uploaded sidecar.
func parseCursorTrack(raw string) (*CursorTrack, error) {
	if len(raw) > maxCursorBytes {
		return nil, fmt.Errorf("cursor data is %d bytes, over the %d limit", len(raw), maxCursorBytes)
	}
	var c CursorTrack
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return nil, fmt.Errorf("cursor field: %w", err)
	}
	if c.Version == 0 {
		return nil, fmt.Errorf("cursor field: missing version")
	}
	if c.Video.Width <= 0 || c.Video.Height <= 0 {
		// Without the frame the samples were mapped into, the coordinates mean
		// nothing — better to refuse than to store a set of unplaceable points.
		return nil, fmt.Errorf("cursor field: missing video dimensions")
	}
	if len(c.Samples) == 0 {
		return nil, fmt.Errorf("cursor field: no samples")
	}
	return &c, nil
}

// writeCursorTrack stores the sidecar beside a media file.
func writeCursorTrack(mediaPath string, c *CursorTrack) error {
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(cursorPath(mediaPath), data, 0o644)
}

// readCursorTrack loads the sidecar beside a media file, if there is one. A
// missing sidecar is not an error: most clips have no cursor data, and the ones
// that do are the exception.
func readCursorTrack(mediaPath string) (*CursorTrack, error) {
	path := cursorPath(mediaPath)
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil
	}
	if info.Size() > maxCursorBytes {
		return nil, fmt.Errorf("%s is %d bytes, over the %d limit", filepath.Base(path), info.Size(), maxCursorBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return parseCursorTrack(string(data))
}
