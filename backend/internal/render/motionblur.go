package render

import (
	"fmt"
	"strings"

	"studio/internal/schema"
)

// motionBlurFilter returns a tmix chain for cinematic motion blur when a clip
// has camera motion keyframes. amount is 0..1 (0 = off).
func motionBlurFilter(amount float64, keyframes map[string][]schema.Keyframe) string {
	if amount <= 0 || keyframes == nil {
		return ""
	}
	hasMotion := len(keyframes["scale"]) > 0 || len(keyframes["x"]) > 0 || len(keyframes["y"]) > 0
	if !hasMotion {
		return ""
	}
	n := 3 + int(amount*4+0.5)
	if n < 3 {
		n = 3
	}
	if n > 7 {
		n = 7
	}
	weights := make([]string, n)
	mid := float64(n-1) / 2
	for i := 0; i < n; i++ {
		d := mid - float64(i)
		if d < 0 {
			d = -d
		}
		w := mid + 1 - d
		if w < 1 {
			w = 1
		}
		weights[i] = fmt.Sprintf("%d", int(w+0.5))
	}
	return fmt.Sprintf(",tmix=frames=%d:weights='%s'", n, strings.Join(weights, " "))
}
