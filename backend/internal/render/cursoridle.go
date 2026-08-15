package render

import (
	"math"

	"studio/internal/cursor"
)

// Fading out a cursor that has been parked.
//
// A tutorial spends a lot of its length with the pointer abandoned in a corner
// while the narrator talks, and a cursor sitting in shot for thirty seconds is
// pure distraction — the viewer keeps checking whether it is about to do
// something. Screen recorders that look hand-made all hide it and bring it back
// the instant it moves.
//
// This only works because Studio draws the cursor itself. A burned-in cursor
// cannot be faded out, which is why the whole feature is gated on the same
// track.Hidden as the drawn pointer.
//
// The alpha is computed from the sample track rather than authored as
// keyframes, so it survives trimming, speed changes and re-smoothing without
// anyone maintaining it. Both halves of the app compute it identically — see
// cursor-draw.ts, and the goldens in cursoridle_test.go that pin the pair.

const (
	// The fades are deliberately asymmetric. Leaving should be an exit nobody
	// notices; arriving must be instant, because the moment the pointer moves
	// the viewer is already looking for it. A symmetric fade-in reads as lag.
	pointerFadeOut = 0.45
	pointerFadeIn  = 0.12

	// How still counts as parked, in recording pixels at a 1920-wide reference
	// and scaled to the actual capture. Quoting it absolutely would make the
	// same hand movement read as parked on a 1080p capture and as motion on a
	// 4K one — the bug findFocusSegments' radii already had once.
	pointerIdlePx  = 3.0
	pointerIdleRef = 1920.0

	// Resolution of the emitted alpha ramp. sendcmd is a list of discrete
	// commands, so a fade has to be spelled out; 50ms is well under the eye's
	// threshold for a smooth ramp and keeps a long recording's script small.
	pointerFadeStep = 0.05
)

// idleSpan is a stretch of source time over which the pointer never left a
// small radius. Start is the moment it stopped, so the fade begins at
// Start+hideAfter and the pointer is back at full alpha after End.
type idleSpan struct{ Start, End float64 }

// pointerIdleSpans finds the stretches where the pointer is parked.
//
// A press is movement even when the coordinates do not change: clicking a
// button without nudging the mouse is the pointer being used, and fading it out
// mid-click would be absurd. The heartbeat the sampler emits every 250ms while
// nothing happens is what makes a parked stretch detectable at all.
func pointerIdleSpans(samples []cursor.Sample, videoW int, hideAfter float64) []idleSpan {
	if len(samples) < 2 || hideAfter <= 0 {
		return nil
	}
	tol := pointerIdlePx
	if videoW > 0 {
		tol = pointerIdlePx * float64(videoW) / pointerIdleRef
	}

	var spans []idleSpan
	anchor := samples[0]
	start := float64(samples[0].T) / 1000
	var down uint8
	for _, s := range samples[1:] {
		t := float64(s.T) / 1000
		moved := math.Hypot(float64(s.X-anchor.X), float64(s.Y-anchor.Y)) > tol
		// A press edge and a release both count as activity, so a click that
		// lands without moving the mouse still wakes the cursor up.
		clicked := s.Down != down
		down = s.Down
		if !moved && !clicked {
			continue
		}
		if t-start > hideAfter {
			spans = append(spans, idleSpan{Start: start, End: t})
		}
		anchor, start = s, t
	}
	// The tail: parked from the last movement to the end of the track. It gets
	// no fade back in, which is correct — nothing follows it.
	if last := float64(samples[len(samples)-1].T) / 1000; last-start > hideAfter {
		spans = append(spans, idleSpan{Start: start, End: last})
	}
	return spans
}

// pointerAlphaAt is the drawn pointer's opacity multiplier at source time t.
//
// Spans ascend, and a span that has not started yet cannot affect the present,
// so the scan stops at the first one in the future. The span before t matters
// either because t is inside it (fading out) or because t is just past it
// (fading back in from wherever the fade-out got to — a park two seconds long
// with a 0.45s fade only ever reached zero, but one that lasted 0.5s past the
// threshold did not, and coming back from full transparency would flash).
func pointerAlphaAt(spans []idleSpan, hideAfter, t float64) float64 {
	a := 1.0
	for _, s := range spans {
		if t < s.Start {
			break
		}
		hideAt := s.Start + hideAfter
		if t <= s.End {
			a = 1 - clampF((t-hideAt)/pointerFadeOut, 0, 1)
			break
		}
		reached := 1 - clampF((s.End-hideAt)/pointerFadeOut, 0, 1)
		a = reached + (1-reached)*clampF((t-s.End)/pointerFadeIn, 0, 1)
	}
	return clampF(a, 0, 1)
}

// alphaStep is one point on the emitted ramp, in source seconds.
type alphaStep struct {
	T float64
	A float64
}

// pointerAlphaSteps spells the fades out as timed values.
//
// Only the fades are sampled — the long flat stretches between them contribute
// one command each. A recording where the pointer parks twenty times costs
// about forty commands per fade edge rather than one per sample, which is the
// difference between this and driving alpha from cursorCommands.
func pointerAlphaSteps(spans []idleSpan, hideAfter float64) []alphaStep {
	var out []alphaStep
	push := func(t, a float64) {
		if n := len(out); n > 0 && math.Abs(out[n-1].A-a) < 0.002 {
			return
		}
		out = append(out, alphaStep{T: t, A: a})
	}
	for _, s := range spans {
		hideAt := s.Start + hideAfter
		// Pin full opacity at the moment the fade starts. Without it the ramp's
		// first command is already below 1 and the cursor steps down instead of
		// easing.
		push(hideAt, 1)
		for t := hideAt; t < s.End; t += pointerFadeStep {
			push(t, pointerAlphaAt(spans, hideAfter, t))
			if t-hideAt > pointerFadeOut {
				break
			}
		}
		push(s.End, pointerAlphaAt(spans, hideAfter, s.End))
		for t := s.End; t <= s.End+pointerFadeIn+1e-9; t += pointerFadeStep {
			push(t, pointerAlphaAt(spans, hideAfter, t))
		}
		push(s.End+pointerFadeIn, 1)
	}
	return out
}
