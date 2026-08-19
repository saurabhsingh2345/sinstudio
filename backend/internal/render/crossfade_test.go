package render

import (
	"strings"
	"testing"

	"studio/internal/schema"
)

func vclip(id string, start, out float64) schema.Clip {
	return schema.Clip{
		ID: id, AssetID: id, Start: start, In: 0, Out: out,
		Transform: schema.Transform{Scale: 1, Opacity: 1},
	}
}

func lane(kind string, clips ...schema.Clip) []schema.Track {
	return []schema.Track{{ID: "t", Kind: kind, Clips: clips}}
}

// TestJointHoldsTheOutgoingScene is the bug this file was written for: two clips
// laid end to end with a fade on the second one dissolved up from the canvas
// background instead of out of the first clip. The outgoing clip now holds its
// last frame for the transition's length so there is a scene to dissolve out of.
func TestJointHoldsTheOutgoingScene(t *testing.T) {
	a := vclip("a", 0, 5)
	b := vclip("b", 5, 5)
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 0.35}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	if _, cover := plan.resolve(a); cover != 0.35 {
		t.Errorf("outgoing clip cover = %v, want 0.35", cover)
	}
	if _, cover := plan.resolve(b); cover != 0 {
		t.Errorf("incoming clip should hold nothing, got %v", cover)
	}
	if got, _ := plan.resolve(b); got.TransitionIn == nil || got.TransitionIn.Type != "fade" {
		t.Errorf("incoming clip should keep its own transition, got %+v", got.TransitionIn)
	}
}

// TestJointPromotesATransitionOut confirms the rule reads the same joint from
// either side: a dissolve written as "A transitions out" becomes the dissolve
// INTO B, because fading A out under B could only reveal the background.
func TestJointPromotesATransitionOut(t *testing.T) {
	a := vclip("a", 0, 5)
	a.TransitionOut = &schema.Transition{Type: "dissolve", Duration: 0.4}
	b := vclip("b", 5, 5)

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	ra, cover := plan.resolve(a)
	if ra.TransitionOut != nil {
		t.Errorf("A's fade to background should be dropped at a joint, got %+v", ra.TransitionOut)
	}
	if cover != 0.4 {
		t.Errorf("cover = %v, want 0.4", cover)
	}
	rb, _ := plan.resolve(b)
	if rb.TransitionIn == nil || rb.TransitionIn.Duration != 0.4 {
		t.Fatalf("B should inherit the dissolve, got %+v", rb.TransitionIn)
	}
}

// TestOverlapNeedsNoFreeze: clips the author already overlapped have real frames
// under the transition, so only the uncovered remainder is frozen.
func TestOverlapNeedsNoFreeze(t *testing.T) {
	a := vclip("a", 0, 5)
	b := vclip("b", 4.8, 5)
	b.TransitionIn = &schema.Transition{Type: "dissolve", Duration: 0.5}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	_, cover := plan.resolve(a)
	if got, want := cover, 0.3; got < want-1e-9 || got > want+1e-9 {
		t.Errorf("cover = %v, want %v (0.5 transition less the 0.2 overlap)", got, want)
	}

	b.TransitionIn = &schema.Transition{Type: "dissolve", Duration: 0.1}
	plan = planCrossfades(lane(schema.TrackVideo, a, b))
	if _, cover := plan.resolve(a); cover != 0 {
		t.Errorf("an overlap longer than the transition needs no freeze, got %v", cover)
	}
}

// TestGapKeepsTheBackground: a fade with nothing under it is a fade to the
// canvas, which is what a fade at a gap or at the head of the timeline is for.
func TestGapKeepsTheBackground(t *testing.T) {
	a := vclip("a", 0, 5)
	b := vclip("b", 6, 5) // one second of daylight between them
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 0.35}
	a.TransitionOut = &schema.Transition{Type: "fade", Duration: 0.35}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	ra, cover := plan.resolve(a)
	if cover != 0 {
		t.Errorf("cover across a gap = %v, want 0", cover)
	}
	if ra.TransitionOut == nil {
		t.Error("A's fade out should survive: there is nothing to dissolve into")
	}
}

// TestOverlayJointsAreLeftAlone: an overlay clip fades out to transparent and
// reveals the video below it, which was never the bug. Holding one over its
// successor would park a stale badge on top of the next scene.
func TestOverlayJointsAreLeftAlone(t *testing.T) {
	a := vclip("a", 0, 5)
	a.TransitionOut = &schema.Transition{Type: "fade", Duration: 0.35}
	b := vclip("b", 5, 5)
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 0.35}

	plan := planCrossfades(lane(schema.TrackOverlay, a, b))
	if len(plan) != 0 {
		t.Errorf("overlay lane should plan no joints, got %+v", plan)
	}
}

// TestDeliberateFadeOutKeepsItsHole: FadeOut is the punctuation between scenes —
// fade down to the canvas and back up. A document asking for one still gets it,
// so the outgoing clip is not held over the cut.
func TestDeliberateFadeOutKeepsItsHole(t *testing.T) {
	a := vclip("a", 0, 5)
	a.FadeOut = 0.5
	b := vclip("b", 5, 5)
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 0.5}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	if _, cover := plan.resolve(a); cover != 0 {
		t.Errorf("cover = %v, want 0 — the fade to background was asked for", cover)
	}
}

// TestCoverStaysInsideTheSuccessor keeps the freeze from outliving the clip it
// was meant to introduce, which would also lengthen the render.
func TestCoverStaysInsideTheSuccessor(t *testing.T) {
	a := vclip("a", 0, 5)
	b := vclip("b", 5, 0.2) // a 0.2s clip
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 2}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	if _, cover := plan.resolve(a); cover != 0.2 {
		t.Errorf("cover = %v, want 0.2 (the successor's whole length)", cover)
	}
}

// TestClipPaintedOnTopIsNotHeld: the rule needs the incoming clip over the
// outgoing one. Where z says otherwise, holding the outgoing clip would blank
// the incoming scene rather than reveal it, so the joint is left alone.
func TestClipPaintedOnTopIsNotHeld(t *testing.T) {
	a := vclip("a", 0, 5)
	a.Z = 5
	b := vclip("b", 5, 5)
	b.Z = 1
	b.TransitionIn = &schema.Transition{Type: "fade", Duration: 0.35}

	plan := planCrossfades(lane(schema.TrackVideo, a, b))
	if _, cover := plan.resolve(a); cover != 0 {
		t.Errorf("cover = %v, want 0 — A is painted over B", cover)
	}
}

// TestJointCompilesToAFreezeAndNoFadeOut checks the filtergraph itself: the
// outgoing clip gets the tpad freeze and keeps its alpha, and only the incoming
// clip fades.
func TestJointCompilesToAFreezeAndNoFadeOut(t *testing.T) {
	a := vclip("a", 0, 5)
	a.TransitionOut = &schema.Transition{Type: "dissolve", Duration: 0.4}
	b := vclip("b", 5, 5)

	doc := &schema.EditDoc{
		Canvas: schema.Canvas{Width: 640, Height: 360, FPS: 24},
		Tracks: lane(schema.TrackVideo, a, b),
	}
	resolve := func(id string) (string, bool) { return "/tmp/" + id + ".mp4", true }
	plan, err := Compile(doc, resolve, "/tmp/o.mp4", t.TempDir(), Options{})
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	graph := strings.Join(plan.Args, " ")
	if !strings.Contains(graph, "tpad=stop_mode=clone:stop_duration=0.400") {
		t.Errorf("outgoing clip should freeze for the transition:\n%s", graph)
	}
	if strings.Contains(graph, "fade=t=out") {
		t.Errorf("no clip should fade to the background at a joint:\n%s", graph)
	}
	if !strings.Contains(graph, "fade=t=in:st=5.000:d=0.400") {
		t.Errorf("incoming clip should dissolve in over the freeze:\n%s", graph)
	}
	// The freeze lives inside the successor's span, so the render is no longer.
	if plan.Dur != 10 {
		t.Errorf("duration = %v, want 10", plan.Dur)
	}
}
