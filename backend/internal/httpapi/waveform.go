package httpapi

import (
	"encoding/binary"
	"errors"
	"math"
	"net/http"
	"os/exec"
	"sync"
)

const waveBuckets = 1200 // resolution of the cached peak array

var (
	waveMu    sync.Mutex
	waveCache = map[string][]float64{} // abs path -> normalized peaks (0..1)
)

// waveform returns a normalized peak array for an asset's audio, computed once
// per file (ffmpeg → mono PCM → bucketed absolute peaks) and cached in memory.
// The frontend slices/stretches it to a clip's trim + zoom.
func (s *Server) waveform(w http.ResponseWriter, r *http.Request) {
	doc, err := s.Store.GetProject(r.PathValue("id"))
	if err != nil {
		httpErr(w, 404, err)
		return
	}
	assetID := r.URL.Query().Get("asset")
	var path string
	for _, a := range doc.Assets {
		if a.ID == assetID {
			path = s.Store.Abs(a.Path)
			break
		}
	}
	if path == "" {
		httpErr(w, 404, errors.New("asset not found"))
		return
	}

	waveMu.Lock()
	peaks, ok := waveCache[path]
	waveMu.Unlock()
	if !ok {
		peaks, err = computePeaks(path, waveBuckets)
		if err != nil {
			httpErr(w, 500, err)
			return
		}
		waveMu.Lock()
		waveCache[path] = peaks
		waveMu.Unlock()
	}
	writeJSON(w, 200, map[string]any{"peaks": peaks})
}

// computePeaks decodes the file to mono 8kHz signed-16 PCM and reduces it to
// `buckets` absolute peak amplitudes normalized to 0..1. An empty slice means
// the source has no audio.
func computePeaks(path string, buckets int) ([]float64, error) {
	out, err := exec.Command("ffmpeg", "-v", "error", "-i", path,
		"-ac", "1", "-ar", "8000", "-f", "s16le", "-").Output()
	if err != nil {
		// No audio stream (or decode failure) → treat as silent, don't error the UI.
		return []float64{}, nil
	}
	samples := len(out) / 2
	if samples == 0 {
		return []float64{}, nil
	}
	peaks := make([]float64, buckets)
	per := samples / buckets
	if per < 1 {
		per = 1
	}
	for b := 0; b < buckets; b++ {
		start := b * per
		var max float64
		for i := 0; i < per && start+i < samples; i++ {
			v := int16(binary.LittleEndian.Uint16(out[(start+i)*2:]))
			a := math.Abs(float64(v)) / 32768
			if a > max {
				max = a
			}
		}
		peaks[b] = max
	}
	return peaks, nil
}
