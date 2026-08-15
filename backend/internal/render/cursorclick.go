package render

import (
	"studio/internal/cursor"
)

// The cursor's own reaction to a click.
//
// Studio already draws an expanding ring at each press, which tells the viewer
// *where* a click landed. What it does not do is make the click look like a
// press — and the thing a viewer reads as "that was pressed" is the pointer
// itself giving, the way a real button does. It is a small movement and it is
// most of the difference between a cursor that is drawn on top of a video and
// one that appears to be doing something.
//
// The dip rides the pointer's existing scale command rather than adding a
// filter. A second scale in series would resample the cursor twice, and an
// overlay input that changes size mid-render is exactly the reconfiguration
// that breaks overlay's format negotiation (see the click ring's missing
// format=auto in render.go).

const (
	// Down fast, back slowly: a press is an impact and a release is a recovery.
	// Equal times read as a wobble rather than as a click.
	clickDipIn  = 0.06
	clickDipOut = 0.26
	// The deepest a full-strength dip goes. Past about a third the cursor reads
	// as jumping away from the thing it clicked rather than pressing it.
	clickDipMax = 0.28
	// Spacing of the extra control points spliced in around a press. The
	// sampler drops to a 250ms heartbeat when the pointer is resting, and a
	// click while resting is the common case — clicking a button you have
	// already moved to. At heartbeat resolution the dip would be two steps.
	clickDipStep = 0.02
)

// pointerClickScale is the drawn cursor's size multiplier at source time t.
//
// The return leg uses easeOutBack, so the cursor passes very slightly beyond
// its own size before settling. That overshoot is wanted here — unlike the
// camera's, which is clamped, because a cursor a few percent large for two
// frames costs nothing and is what makes the press feel sprung.
func pointerClickScale(clicks []float64, t, amount float64) float64 {
	if amount <= 0 || len(clicks) == 0 {
		return 1
	}
	depth := clampF(amount, 0, 1) * clickDipMax
	for _, ct := range clicks {
		d := t - ct
		if d < 0 || d > clickDipIn+clickDipOut {
			continue
		}
		if d <= clickDipIn {
			return 1 - depth*easeValue("easeOutCubic", d/clickDipIn)
		}
		return 1 - depth*(1-easeValue("easeOutBack", (d-clickDipIn)/clickDipOut))
	}
	return 1
}

// densifyForClicks splices extra samples through each press so the dip is
// emitted as a ramp instead of at whatever rate the pointer happened to be
// sampled.
//
// The inserted samples carry the Down value of the sample they follow, never a
// fresh zero. A zero spliced between two pressed samples reads as a release and
// then a second press — inventing a click that never happened, in the one data
// structure every other effect keys off.
func densifyForClicks(samples []cursor.Sample, clicks []float64) []cursor.Sample {
	if len(clicks) == 0 || len(samples) < 2 {
		return samples
	}
	// Every extra instant we want a command at, in ascending order.
	var want []int64
	for _, ct := range clicks {
		for d := 0.0; d <= clickDipIn+clickDipOut; d += clickDipStep {
			want = append(want, int64((ct+d)*1000))
		}
	}

	out := make([]cursor.Sample, 0, len(samples)+len(want))
	wi := 0
	for i, s := range samples {
		// Anything due before this sample is interpolated from the gap it falls
		// in, matching Track.At's linear rule so the drawn cursor does not step
		// off the path the rest of the effects follow.
		for wi < len(want) && want[wi] < s.T {
			w := want[wi]
			wi++
			if i == 0 {
				continue // before the track starts; At would hold, so add nothing
			}
			a := samples[i-1]
			if w <= a.T {
				continue
			}
			span := float64(s.T - a.T)
			if span <= 0 {
				continue
			}
			f := float64(w-a.T) / span
			out = append(out, cursor.Sample{
				T:    w,
				X:    a.X + int(float64(s.X-a.X)*f),
				Y:    a.Y + int(float64(s.Y-a.Y)*f),
				Down: a.Down,
			})
		}
		for wi < len(want) && want[wi] == s.T {
			wi++ // already covered by a real sample
		}
		out = append(out, s)
	}
	// Past the last sample the position is held, so the tail of a dip from a
	// click near the end still needs its points.
	last := samples[len(samples)-1]
	for ; wi < len(want); wi++ {
		if want[wi] > last.T {
			out = append(out, cursor.Sample{T: want[wi], X: last.X, Y: last.Y, Down: last.Down})
		}
	}
	return out
}
