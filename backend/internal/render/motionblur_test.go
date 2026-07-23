package render

import (
	"testing"

	"studio/internal/schema"
)

func TestMotionBlurFilterOff(t *testing.T) {
	if got := motionBlurFilter(0, map[string][]schema.Keyframe{"scale": {{T: 0, Value: 1}}}); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
	if got := motionBlurFilter(0.5, nil); got != "" {
		t.Fatalf("expected empty without keyframes, got %q", got)
	}
	if got := motionBlurFilter(0.5, map[string][]schema.Keyframe{}); got != "" {
		t.Fatalf("expected empty without motion keyframes, got %q", got)
	}
}

func TestMotionBlurFilterOn(t *testing.T) {
	kf := map[string][]schema.Keyframe{"scale": {{T: 0, Value: 1}, {T: 1, Value: 1.5}}}
	got := motionBlurFilter(0.5, kf)
	if got == "" {
		t.Fatal("expected tmix filter")
	}
	if want := ",tmix=frames="; got[:len(want)] != want {
		t.Fatalf("expected tmix prefix, got %q", got)
	}
}
