package render

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"studio/internal/schema"
)

// writeSRT renders caption cues to a SubRip file for the subtitles filter.
func writeSRT(path string, cues []schema.CaptionCue) error {
	sorted := append([]schema.CaptionCue(nil), cues...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })

	var b strings.Builder
	for i, c := range sorted {
		if c.End <= c.Start || strings.TrimSpace(c.Text) == "" {
			continue
		}
		fmt.Fprintf(&b, "%d\n%s --> %s\n%s\n\n", i+1, srtTime(c.Start), srtTime(c.End), c.Text)
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

// srtTime formats seconds as HH:MM:SS,mmm.
func srtTime(sec float64) string {
	if sec < 0 {
		sec = 0
	}
	ms := int(sec*1000 + 0.5)
	h := ms / 3600000
	ms -= h * 3600000
	m := ms / 60000
	ms -= m * 60000
	s := ms / 1000
	ms -= s * 1000
	return fmt.Sprintf("%02d:%02d:%02d,%03d", h, m, s, ms)
}
