package render

import (
	"encoding/binary"
	"math"
	"os"

	"studio/internal/cursor"
)

// Click sounds, synthesised rather than sampled.
//
// A real mouse click is a broadband transient a few milliseconds long, which is
// cheap to generate and awkward to ship: audio files mean binary assets in the
// repo, a licence to track, and a fixed character nobody can adjust. Generating
// it makes pitch, length and weight into parameters.
//
// The whole clip gets ONE file with every click already positioned in it. A
// separate input per click would be simpler to write and would put hundreds of
// inputs into the filtergraph on a normal tutorial — the same trap the caption
// burn-in already walks into, and one worth not repeating.

const (
	clickSampleRate = 48000
	defClickVolume  = 0.35
)

// clickTone is one style's voice: how fast it decays, its tonal centre, and how
// much of it is noise rather than tone.
type clickTone struct {
	tau   float64 // decay constant, seconds
	freq  float64 // tonal centre, Hz
	noise float64 // 0..1 share of noise vs tone
}

// Styles, chosen to span "barely there" to "unmistakable". The defaults sit
// where a tutorial wants them: audible under narration, gone before it matters.
var clickTones = map[string]clickTone{
	"click": {tau: 0.0045, freq: 2400, noise: 0.72},
	"tick":  {tau: 0.0030, freq: 4200, noise: 0.35},
	"soft":  {tau: 0.0090, freq: 1400, noise: 0.55},
}

// rng is a tiny deterministic generator, seeded per file.
//
// The noise in a click MUST be reproducible: a render that produces different
// audio each time breaks content-addressed caching, and this project already
// has one generator with exactly that problem. Same document, same bytes.
type rng struct{ s uint64 }

func (r *rng) next() float64 {
	// xorshift64*, entirely adequate for shaping a 5ms transient.
	r.s ^= r.s >> 12
	r.s ^= r.s << 25
	r.s ^= r.s >> 27
	return float64(int64((r.s*2685821657736338717)>>11))/float64(int64(1)<<52) - 1
}

// clickAt renders one transient into buf starting at sample index `at`.
func clickAt(buf []float64, at int, tone clickTone, gain float64, seed uint64) {
	r := rng{s: seed | 1}
	// Six time constants is inaudible; going further just costs samples.
	n := int(tone.tau * 6 * clickSampleRate)
	for i := 0; i < n; i++ {
		idx := at + i
		if idx < 0 || idx >= len(buf) {
			break
		}
		t := float64(i) / clickSampleRate
		env := math.Exp(-t / tone.tau)
		tonal := math.Sin(2 * math.Pi * tone.freq * t)
		v := (tonal*(1-tone.noise) + r.next()*tone.noise) * env * gain
		buf[idx] += v
	}
}

// writeClickWAV renders a clip-length mono track containing one transient per
// press. Times are seconds from the clip's first frame.
//
// A right button is pitched down slightly. Real mice differ that way, and it
// lets a viewer tell a context menu from a selection without being told.
func writeClickWAV(path string, track *cursor.Track, dur float64, style string, volume float64) (int, error) {
	tone, ok := clickTones[style]
	if !ok {
		tone = clickTones["click"]
	}
	gain := volume
	if gain <= 0 {
		gain = defClickVolume
	}

	total := int(math.Max(0.05, dur) * clickSampleRate)
	buf := make([]float64, total)

	var count int
	var prev uint8
	for i, s := range track.Samples {
		if s.Down == 0 || prev != 0 {
			prev = s.Down
			continue
		}
		prev = s.Down
		ts := float64(s.T) / 1000
		if ts < 0 || ts > dur {
			continue
		}
		t := tone
		if s.Down&cursor.ButtonRight != 0 {
			t.freq *= 0.78
		}
		// Seeded from the sample index so every click is reproducible but they
		// are not all bit-identical — a row of literally identical transients
		// reads as a machine gun rather than a hand.
		clickAt(buf, int(ts*clickSampleRate), t, gain, uint64(i)*2654435761+12345)
		count++
	}
	if count == 0 {
		return 0, nil
	}

	// Soft-clip rather than wrap: two clicks landing together should thicken,
	// not tear.
	pcm := make([]byte, total*2)
	for i, v := range buf {
		v = math.Tanh(v)
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(clampF(v, -1, 1)*32767)))
	}
	return count, writeWAV(path, pcm, clickSampleRate, 1)
}

// writeWAV wraps PCM in a canonical 44-byte RIFF header.
func writeWAV(path string, pcm []byte, rate, channels int) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	byteRate := rate * channels * 2
	var h []byte
	put32 := func(v uint32) { h = binary.LittleEndian.AppendUint32(h, v) }
	put16 := func(v uint16) { h = binary.LittleEndian.AppendUint16(h, v) }

	h = append(h, "RIFF"...)
	put32(uint32(36 + len(pcm)))
	h = append(h, "WAVEfmt "...)
	put32(16)                   // PCM chunk size
	put16(1)                    // PCM
	put16(uint16(channels))     //
	put32(uint32(rate))         //
	put32(uint32(byteRate))     //
	put16(uint16(channels * 2)) // block align
	put16(16)                   // bits per sample
	h = append(h, "data"...)    //
	put32(uint32(len(pcm)))     //

	if _, err := f.Write(h); err != nil {
		return err
	}
	_, err = f.Write(pcm)
	return err
}
