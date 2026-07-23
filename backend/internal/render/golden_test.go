package render

import "studio/internal/cursor"

// goldenSamples is a fixed pointer path shared by the Go and TypeScript twins
// of the cursor maths. The preview and the export are separate implementations;
// asserting the same numbers on both sides is what catches one drifting.
func goldenSamples() []cursor.Sample {
	out := make([]cursor.Sample, 0, 20)
	for i := 0; i < 20; i++ {
		s := cursor.Sample{T: int64(i * 16), X: 100 + i*7, Y: 200 - i*3}
		if i%2 == 0 {
			s.X += 5 // jitter for smoothing to bite on
		}
		if i == 12 {
			s.Down = cursor.ButtonLeft
		}
		out = append(out, s)
	}
	return out
}

// The values below are the contract. frontend/src/components/studio/
// cursor-draw.test.ts asserts the identical numbers from its own
// implementation, so a change to either side that is not mirrored fails here or
// there rather than silently making the preview lie about the export.
