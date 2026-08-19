package render

import "studio/internal/cursor"

// Gliding the cursor back to where it started, so a loop has no jump cut.
//
// A product demo is usually watched twice: it autoplays on a landing page, or
// it is a GIF in a README. The picture loops cleanly because the recording was
// framed to, but the cursor does not — it ends wherever the last click left it
// and reappears at the top-left an instant later. That jump is the single most
// obvious tell that a loop is a loop.
//
// Nothing else can fix it. Trimming the tail moves the problem; a cross-fade
// blurs the whole frame to hide one small object. The cursor's position is data
// we own, so the honest fix is to walk it home over the last stretch of the
// take, which is what a person would have done if they had remembered to.
//
// Deliberately NOT applied inside a click's window: the glide is a fiction, and
// a fiction that drags the pointer off the button it is pressing is worse than
// the jump it fixes. If a click lands inside the requested window the return
// starts after it instead, so the glide is shortened rather than dishonest.

// loopClickHold is how long after a press the pointer stays where it landed
// before the glide may begin — long enough for the click's ring to read.
const loopClickHold = 0.3

// loopReturnPath eases the tail of a path back to where it began.
//
// from/to are the clip's visible source range, not the track's: a trimmed clip
// loops at its own out point, and gliding home over a stretch that was cut is
// no glide at all.
func loopReturnPath(samples []cursor.Sample, dur, from, to float64) []cursor.Sample {
	if dur <= 0 || len(samples) < 2 || to <= from {
		return samples
	}
	tr := &cursor.Track{Samples: samples}
	homeX, homeY := tr.At(from)

	begin := to - dur
	if begin < from {
		begin = from
	}
	// Push past the last press inside the window, so a click near the end keeps
	// its position and the glide takes whatever time is left.
	var prev uint8
	for _, s := range samples {
		t := float64(s.T) / 1000
		if t > to {
			break
		}
		if s.Down != 0 && prev == 0 && t+loopClickHold > begin {
			begin = t + loopClickHold
		}
		prev = s.Down
	}
	if begin >= to {
		return samples
	}

	out := make([]cursor.Sample, len(samples))
	copy(out, samples)
	span := to - begin
	for i, s := range samples {
		t := float64(s.T) / 1000
		if t <= begin || t > to {
			continue
		}
		// Smootherstep, so the glide leaves and arrives at rest. A linear walk
		// home reads as the cursor being dragged by something.
		p := easeValue("easeInOut", (t-begin)/span)
		out[i].X = int(float64(s.X)*(1-p) + float64(homeX)*p)
		out[i].Y = int(float64(s.Y)*(1-p) + float64(homeY)*p)
	}
	return out
}
