package render

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"strings"

	"studio/internal/schema"
)

/*
Device frames — putting a recording inside a phone, a laptop or a browser
window.

The frames are DRAWN rather than shipped as PNG art. Three reasons, in order of
how much they mattered: a bundled mockup is a fixed number of pixels and goes
soft the moment the export is 4K or the clip is zoomed, whereas these are
rebuilt at whatever size is being rendered; the screen cut-out has to line up
with the video to the pixel, which means the geometry has to be a number this
code knows rather than a property of an image someone exported; and a drawn
frame recolours with a field instead of needing one asset per colourway.

They reuse the signed-distance machinery from annotation.go, so a rounded corner
here antialiases exactly like a callout's does.

The composite happens at CANVAS resolution, before the clip's own transform. So
the device and the screen inside it scale, move and keyframe as ONE object —
zooming a framed clip pushes into the phone rather than sliding the phone out
from behind its own picture, which is what would happen if the frame were an
overlay placed separately on top.
*/

// deviceGeom is where the video goes, in canvas pixels. The renderer scales and
// pads the clip into exactly this rectangle and then lays the frame over it.
type deviceGeom struct {
	x, y, w, h int
	// radius of the screen's own corners, for clipping the picture to them.
	radius float64
}

// deviceSpec is one device's proportions, all as fractions of its own box.
type deviceSpec struct {
	aspect float64 // outer width / outer height
	// The screen, as fractions of the device box.
	sx, sy, sw, sh float64
	bodyRadius     float64 // fraction of the device's WIDTH
	screenRadius   float64 // fraction of the device's width
	notch          bool    // a phone's camera cut-out
	homeBar        bool
	browserChrome  bool    // a title bar with traffic lights and a URL pill
	laptopBase     float64 // fraction of device height taken by the deck, 0 = none
}

func deviceSpecFor(kind string) deviceSpec {
	switch kind {
	case schema.DevicePhone:
		return deviceSpec{
			aspect: 0.49, sx: 0.043, sy: 0.021, sw: 0.914, sh: 0.958,
			bodyRadius: 0.13, screenRadius: 0.10, notch: true, homeBar: true,
		}
	case schema.DeviceTablet:
		return deviceSpec{
			aspect: 0.75, sx: 0.055, sy: 0.042, sw: 0.89, sh: 0.916,
			bodyRadius: 0.05, screenRadius: 0.035,
		}
	case schema.DeviceLaptop:
		// Screen aspect ≈1.72, near enough to 16:9 that a normal recording only
		// letterboxes by a few pixels. Sized deliberately: at the first pass the
		// screen was 1.54 and a 16:9 clip sat in obvious black bars, which reads
		// as the frame being wrong rather than as the footage not fitting.
		return deviceSpec{
			aspect: 1.55, sx: 0.07, sy: 0.037, sw: 0.86, sh: 0.775,
			bodyRadius: 0.018, screenRadius: 0.012, laptopBase: 0.115,
		}
	default: // browser
		return deviceSpec{
			aspect: 1.62, sx: 0.008, sy: 0.082, sw: 0.984, sh: 0.893,
			bodyRadius: 0.012, screenRadius: 0.004, browserChrome: true,
		}
	}
}

// even rounds down to an even number, with a floor of 2 — the same 4:2:0
// constraint the region recorder has: an odd scale or pad target is either
// refused or silently shifted.
func even(v float64) int {
	n := int(v)
	if n%2 != 0 {
		n--
	}
	if n < 2 {
		return 2
	}
	return n
}

/*
deviceBox fits a device into the canvas, centred, leaving a margin.

The margin is not decoration: a frame drawn hard against the canvas edge has its
shadow and its rounded corners clipped, which reads as a rendering bug rather
than as a style.
*/
func deviceBox(spec deviceSpec, w, h int) (bx, by, bw, bh float64) {
	const margin = 0.94
	fw, fh := float64(w)*margin, float64(h)*margin
	// Fit by whichever axis binds first, so the whole device is always visible.
	if fw/fh > spec.aspect {
		bh = fh
		bw = bh * spec.aspect
	} else {
		bw = fw
		bh = bw / spec.aspect
	}
	return (float64(w) - bw) / 2, (float64(h) - bh) / 2, bw, bh
}

// deviceLayout is the screen rectangle for a device on this canvas, which the
// filtergraph needs before any pixels are drawn.
func deviceLayout(kind string, w, h int) deviceGeom {
	spec := deviceSpecFor(kind)
	bx, by, bw, bh := deviceBox(spec, w, h)
	return deviceGeom{
		x:      even(bx + spec.sx*bw),
		y:      even(by + spec.sy*bh),
		w:      even(spec.sw * bw),
		h:      even(spec.sh * bh),
		radius: spec.screenRadius * bw,
	}
}

// punch clears a shape back to fully transparent, which is how the screen
// cut-out is made: the body is drawn solid and the screen is then removed from
// it, so the two can never disagree about where the opening is.
func punch(img *image.RGBA, d sdf, bounds image.Rectangle) {
	r := bounds.Intersect(img.Bounds())
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			cov := coverage(d(float64(x)+0.5, float64(y)+0.5))
			if cov <= 0 {
				continue
			}
			i := img.PixOffset(x, y)
			keep := 1 - cov
			img.Pix[i] = uint8(float64(img.Pix[i]) * keep)
			img.Pix[i+1] = uint8(float64(img.Pix[i+1]) * keep)
			img.Pix[i+2] = uint8(float64(img.Pix[i+2]) * keep)
			img.Pix[i+3] = uint8(float64(img.Pix[i+3]) * keep)
		}
	}
}

/*
renderDevicePNG draws the frame at canvas size, with the screen left open.

The opening is transparent rather than a colour, because the video has already
been padded into exactly that rectangle underneath — the frame is laid over it,
and anywhere the frame is transparent is where the recording shows.
*/
func renderDevicePNG(dev *schema.DeviceFrame, w, h int, outPath string) error {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	spec := deviceSpecFor(dev.Kind)
	bx, by, bw, bh := deviceBox(spec, w, h)

	body := hexColor(dev.Color, "#1b1d21")
	edge := lighten(body, 34)

	bodyR := spec.bodyRadius * bw
	cx, cy := bx+bw/2, by+bh/2

	// The body, as one rounded slab. A laptop's deck is part of the same shape
	// so the hinge has no seam.
	bodySDF := func(x, y float64) float64 {
		return sdRoundRect(x, y, cx, cy, bw/2, bh/2, bodyR)
	}
	bounds := boxAround(bx, by, bx+bw, by+bh, 8)
	paintSDF(img, bodySDF, bounds, &body, &edge, math.Max(2, bw*0.004))

	// The screen opening.
	sx, sy := bx+spec.sx*bw, by+spec.sy*bh
	sw, sh := spec.sw*bw, spec.sh*bh
	scx, scy := sx+sw/2, sy+sh/2
	screenR := spec.screenRadius * bw
	screenSDF := func(x, y float64) float64 {
		return sdRoundRect(x, y, scx, scy, sw/2, sh/2, screenR)
	}

	if spec.browserChrome {
		drawBrowserChrome(img, bx, by, bw, bh, spec, body)
	}
	if spec.laptopBase > 0 {
		drawLaptopDeck(img, bx, by, bw, bh, spec, body, edge)
	}
	if spec.notch {
		// Drawn BEFORE the punch so the cut-out removes the notch's own pixels
		// too — otherwise the pill floats on top of the video instead of being
		// part of the bezel around it.
		drawNotch(img, bx, by, bw, bh, body)
	}

	punch(img, screenSDF, boxAround(sx, sy, sx+sw, sy+sh, 4))

	if spec.notch {
		// Re-drawn over the opening: on a phone the camera cut-out genuinely
		// sits inside the screen area.
		drawNotch(img, bx, by, bw, bh, body)
	}
	if spec.homeBar {
		bar := color.NRGBA{R: 255, G: 255, B: 255, A: 150}
		bw2 := bw * 0.30
		byy := by + bh*0.978
		d := func(x, y float64) float64 {
			return sdRoundRect(x, y, bx+bw/2, byy, bw2/2, math.Max(1.5, bh*0.0035), math.Max(1.5, bh*0.0035))
		}
		paintSDF(img, d, boxAround(bx+bw/2-bw2, byy-8, bx+bw/2+bw2, byy+8, 4), &bar, nil, 0)
	}

	return encodePNG(outPath, img)
}

// drawNotch is the camera pill at the top of a phone's screen.
func drawNotch(img *image.RGBA, bx, by, bw, bh float64, body color.NRGBA) {
	nw, nh := bw*0.34, bh*0.021
	ncx, ncy := bx+bw/2, by+bh*0.032
	d := func(x, y float64) float64 { return sdRoundRect(x, y, ncx, ncy, nw/2, nh/2, nh/2) }
	paintSDF(img, d, boxAround(ncx-nw, ncy-nh*2, ncx+nw, ncy+nh*2, 4), &body, nil, 0)
}

// drawBrowserChrome is the title bar: traffic lights and an address pill. It is
// what makes a screen recording read as "a web page" rather than as a rectangle.
func drawBrowserChrome(img *image.RGBA, bx, by, bw, bh float64, spec deviceSpec, body color.NRGBA) {
	barH := spec.sy * bh
	dotR := math.Max(2, barH*0.13)
	cy := by + barH*0.5
	for i, c := range []color.NRGBA{
		{R: 255, G: 95, B: 87, A: 255},
		{R: 255, G: 189, B: 46, A: 255},
		{R: 39, G: 201, B: 63, A: 255},
	} {
		cx := bx + barH*(0.55+float64(i)*0.42)
		cc := c
		d := func(x, y float64) float64 { return sdEllipse(x, y, cx, cy, dotR, dotR) }
		paintSDF(img, d, boxAround(cx-dotR*2, cy-dotR*2, cx+dotR*2, cy+dotR*2, 3), &cc, nil, 0)
	}
	// The address pill, lightened off the body so it reads on any colourway.
	pill := lighten(body, 26)
	px0 := bx + barH*2.3
	px1 := bx + bw*0.72
	ph := barH * 0.46
	d := func(x, y float64) float64 {
		return sdRoundRect(x, y, (px0+px1)/2, cy, (px1-px0)/2, ph/2, ph/2)
	}
	paintSDF(img, d, boxAround(px0, cy-ph, px1, cy+ph, 3), &pill, nil, 0)
}

// drawLaptopDeck is the base below the screen, plus the notch you open it by.
func drawLaptopDeck(img *image.RGBA, bx, by, bw, bh float64, spec deviceSpec, body, edge color.NRGBA) {
	deckTop := by + bh*(1-spec.laptopBase)
	deck := lighten(body, 12)
	d := func(x, y float64) float64 {
		return sdRoundRect(x, y, bx+bw/2, (deckTop+by+bh)/2, bw/2, (by+bh-deckTop)/2, bw*0.01)
	}
	paintSDF(img, d, boxAround(bx, deckTop, bx+bw, by+bh, 4), &deck, nil, 0)

	// The thumb scoop, so the deck reads as a lid-and-base rather than a bar.
	nw := bw * 0.12
	nh := bh * spec.laptopBase * 0.30
	nd := func(x, y float64) float64 {
		return sdRoundRect(x, y, bx+bw/2, deckTop, nw/2, nh/2, nh/2)
	}
	paintSDF(img, nd, boxAround(bx+bw/2-nw, deckTop-nh, bx+bw/2+nw, deckTop+nh, 3), &edge, nil, 0)
}

// lighten nudges a colour toward white, for the highlights that keep a flat
// slab from reading as a hole.
func lighten(c color.NRGBA, by int) color.NRGBA {
	add := func(v uint8) uint8 {
		n := int(v) + by
		if n > 255 {
			return 255
		}
		return uint8(n)
	}
	return color.NRGBA{R: add(c.R), G: add(c.G), B: add(c.B), A: c.A}
}

/*
writeDeviceFrame insets the clip's picture into the device and lays the frame
over it, returning the label the chain continues from.

The picture is fitted rather than stretched — a 16:9 recording inside a phone
would otherwise be squeezed to portrait, which is worse than the letterboxing
it avoids. The black it pads with is what a screen shows where there is no
picture, so it reads as intended rather than as a bug.
*/
func writeDeviceFrame(fc *strings.Builder, in string, i, devIdx int, g deviceGeom, w, h int) string {
	scr := fmt.Sprintf("[dvs%d]", i)
	dev := fmt.Sprintf("[dvf%d]", i)
	out := fmt.Sprintf("[dv%d]", i)

	// Fit into the screen opening, centre what is left, then place that opening
	// on a transparent canvas at exactly the coordinates the frame was drawn
	// against — the two agree because both come from deviceLayout.
	fmt.Fprintf(fc,
		"%sscale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black,"+
			"pad=%d:%d:%d:%d:color=black@0,format=rgba%s;",
		in, g.w, g.h, g.w, g.h, w, h, g.x, g.y, scr)
	fmt.Fprintf(fc, "[%d:v]scale=%d:%d,format=rgba%s;", devIdx, w, h, dev)
	fmt.Fprintf(fc, "%s%soverlay=0:0:format=auto%s;", scr, dev, out)
	return out
}
