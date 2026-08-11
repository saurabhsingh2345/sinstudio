package render

import (
	"path/filepath"
	"strings"
	"testing"

	"studio/internal/schema"
)

// A music bed pulled to silence used to come back at FULL gain: the fader wrote
// Volume 0, and the audio-lane loop reads a zero volume as "unset" and defaults
// it to 1. Silence is spelled with Mute, so the lane has to honour it.
func TestMutedAudioClipIsDroppedFromTheMix(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "au", Kind: schema.TrackAudio, Clips: []schema.Clip{{
			ID: "m1", AssetID: "a", Start: 0, In: 0, Out: 2, Volume: 0, Mute: true,
		}}}},
	}
	if args := compileWith(t, doc, src); strings.Contains(args, "volume=") {
		t.Errorf("a muted music clip still reached the mix:\n%s", args)
	}
}

// The same lane, unmuted, must still play — the guard above is about Mute only.
func TestUnmutedAudioClipStillMixes(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "au", Kind: schema.TrackAudio, Clips: []schema.Clip{{
			ID: "m1", AssetID: "a", Start: 0, In: 0, Out: 2, Volume: 0.4,
		}}}},
	}
	if args := compileWith(t, doc, src); !strings.Contains(args, "volume=0.4") {
		t.Errorf("music clip at 40%% did not compile its gain:\n%s", args)
	}
}

// Muting one clip must not silence its neighbours on the same lane.
func TestMuteIsPerClipNotPerLane(t *testing.T) {
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "au", Kind: schema.TrackAudio, Clips: []schema.Clip{
			{ID: "m1", AssetID: "a", Start: 0, In: 0, Out: 2, Mute: true},
			{ID: "m2", AssetID: "a", Start: 2, In: 0, Out: 2, Volume: 0.7},
		}}},
	}
	args := compileWith(t, doc, src)
	if !strings.Contains(args, "volume=0.7") {
		t.Errorf("the unmuted neighbour lost its gain:\n%s", args)
	}
	if strings.Count(args, "volume=") != 1 {
		t.Errorf("expected exactly one audio contribution, got:\n%s", args)
	}
}

func TestMutedAudioLaneLeavesRenderValid(t *testing.T) {
	// An otherwise silent project must still compile (the audio-only path builds
	// its own background), rather than referencing a stream nothing feeds.
	dir := t.TempDir()
	src := audibleSource(t, dir, false)
	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: []schema.Track{{ID: "au", Kind: schema.TrackAudio, Clips: []schema.Clip{{
			ID: "m1", AssetID: "a", Start: 0, In: 0, Out: 2, Mute: true,
		}}}},
	}
	if _, err := Compile(doc, func(string) (string, bool) { return src, true },
		filepath.Join(t.TempDir(), "o.mp4"), t.TempDir(), Options{}); err != nil {
		t.Fatalf("a fully muted project failed to compile: %v", err)
	}
}
