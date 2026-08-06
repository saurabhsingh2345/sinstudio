package render

import (
	"strings"
	"testing"

	"studio/internal/schema"
)

// imageDoc: a video spine with `n` image clips laid on one overlay track.
func imageDoc(clips ...schema.Clip) *schema.EditDoc {
	return &schema.EditDoc{
		Canvas: schema.Canvas{Width: 1280, Height: 720, FPS: 24},
		Assets: []schema.Asset{
			{ID: "vid", Kind: "video", Width: 1280, Height: 720, Duration: 10},
			{ID: "logo", Kind: "image", Width: 400, Height: 400},
			{ID: "badge", Kind: "image", Width: 200, Height: 200},
		},
		Tracks: []schema.Track{
			{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
				ID: "c0", AssetID: "vid", Start: 0, In: 0, Out: 10,
				Transform: schema.Transform{Scale: 1, Opacity: 1},
			}}},
			{ID: "o", Kind: schema.TrackOverlay, Clips: clips},
		},
	}
}

func imgClip(id, asset string, z int) schema.Clip {
	return schema.Clip{
		ID: id, AssetID: asset, Start: 1, In: 0, Out: 5, Z: z,
		Transform: schema.Transform{Scale: 0.3, Opacity: 1},
	}
}

// A still has exactly one frame. Trimmed like a video it decodes that frame and
// the overlay's eof_action=pass drops it a fortieth of a second later — the
// image the preview holds for five seconds flashed once in the export. It has
// to be looped and bounded to the clip's span instead.
func TestImageClipIsLoopedForItsWholeSpan(t *testing.T) {
	args := compileArgs(t, imageDoc(imgClip("c1", "logo", 0)))
	if !strings.Contains(args, "-stream_loop -1 -t 5.000 -i /tmp/logo.mp4") {
		t.Errorf("image clip not looped for its span:\n%s", args)
	}
	if strings.Contains(args, "trim=start=0.000:end=5.000") {
		t.Errorf("image clip took the video trim path (single frame):\n%s", args)
	}
}

// Hold extends the clip past its span, so the loop has to cover both or the
// picture disappears for the tail.
func TestImageClipLoopCoversHold(t *testing.T) {
	c := imgClip("c1", "logo", 0)
	c.Hold = 2
	if args := compileArgs(t, imageDoc(c)); !strings.Contains(args, "-stream_loop -1 -t 7.000 -i /tmp/logo.mp4") {
		t.Errorf("hold not folded into the loop duration:\n%s", args)
	}
}

// A PNG has no audio stream, and mapping [N:a] on one aborts the whole render.
// The ffprobe sweep would normally catch it, but that sweep fails open when
// ffprobe is missing — so the still must never be offered as audio at all.
func TestImageClipContributesNoAudio(t *testing.T) {
	doc := imageDoc(imgClip("c1", "logo", 0))
	doc.Tracks[0].Clips = nil // drop the only real audio source
	args := compileArgs(t, doc)
	if strings.Contains(args, "amix") || strings.Contains(args, ":a]") {
		t.Errorf("an image clip built an audio graph:\n%s", args)
	}
}

// Z stacks clips within one track. The overlay chain is built bottom->top, so
// the higher-Z clip's input must be added — and composited — last.
func TestClipZOrdersWithinATrack(t *testing.T) {
	front := func(args string) string {
		li, bi := strings.Index(args, "-i /tmp/logo.mp4"), strings.Index(args, "-i /tmp/badge.mp4")
		if li < 0 || bi < 0 {
			t.Fatalf("both images should be inputs:\n%s", args)
		}
		if li > bi {
			return "logo"
		}
		return "badge"
	}
	// Array order alone: the later clip is on top, as it always was.
	if got := front(compileArgs(t, imageDoc(imgClip("c1", "logo", 0), imgClip("c2", "badge", 0)))); got != "badge" {
		t.Errorf("untouched z: front = %s, want badge (array order)", got)
	}
	// Z overrides it without moving anything in the document.
	if got := front(compileArgs(t, imageDoc(imgClip("c1", "logo", 2), imgClip("c2", "badge", 1)))); got != "logo" {
		t.Errorf("z=2 vs z=1: front = %s, want logo", got)
	}
}

// Track kind still outranks z: an overlay clip sent all the way to the back of
// its own lane does not fall behind the video spine.
func TestClipZDoesNotEscapeItsTrack(t *testing.T) {
	doc := imageDoc(imgClip("c1", "logo", -99))
	args := compileArgs(t, doc)
	vi, li := strings.Index(args, "-i /tmp/vid.mp4"), strings.Index(args, "-i /tmp/logo.mp4")
	if vi > li {
		t.Errorf("a negative z pushed an overlay clip under the video track:\n%s", args)
	}
}
