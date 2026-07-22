package render

import (
	"strings"
	"testing"

	"studio/internal/schema"
)

// Twins with frontend/src/watermark.test.ts.
func TestWatermarkLayoutGolden(t *testing.T) {
	g := watermarkLayout(&schema.Watermark{}, 200, 100, 1920, 1080)
	if g != (watermarkGeom{x: 1658, y: 934, w: 230, h: 114}) {
		t.Errorf("defaults = %+v, want {1658 934 230 114}", g)
	}
	tl := watermarkLayout(&schema.Watermark{Corner: "tl"}, 200, 100, 1920, 1080)
	if tl.x != 32 || tl.y != 32 {
		t.Errorf("tl = %+v, want margin 32", tl)
	}
	sq := watermarkLayout(&schema.Watermark{}, 0, 0, 1920, 1080)
	if sq.w != sq.h {
		t.Errorf("unknown dims should fall back to square, got %+v", sq)
	}
}

func TestWatermarkEntersTheGraph(t *testing.T) {
	doc := &schema.EditDoc{
		Canvas:    schema.Canvas{Width: 1280, Height: 720, FPS: 24},
		Assets:    []schema.Asset{{ID: "logo", Kind: "image", Width: 200, Height: 100}},
		Watermark: &schema.Watermark{AssetID: "logo", Opacity: 0.5},
		Tracks: []schema.Track{{ID: "v", Kind: schema.TrackVideo, Clips: []schema.Clip{{
			ID: "c1", AssetID: "a", Start: 0, In: 0, Out: 2,
			Transform: schema.Transform{Scale: 1, Opacity: 1},
		}}}},
	}
	args := compileArgs(t, doc)
	if !strings.Contains(args, "colorchannelmixer=aa=0.500[wmk]") {
		t.Errorf("watermark opacity missing from graph:\n%s", args)
	}
	if !strings.Contains(args, "[wmk]overlay=") {
		t.Errorf("watermark overlay missing from graph:\n%s", args)
	}

	doc.Watermark = nil
	if strings.Contains(compileArgs(t, doc), "wmk") {
		t.Error("no watermark configured, yet one entered the graph")
	}
}
