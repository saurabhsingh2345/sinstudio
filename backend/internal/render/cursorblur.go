package render

import "math"

// Motion blur on the cursor itself.
//
// Studio already has a motionBlur on the clip (motionblur.go), which tmixes
// whole frames when the camera moves. That is a different thing and it cannot
// do this one: the drawn cursor is composited on top, after the blur, so it
// stays razor-sharp while the picture behind it smears — which is exactly
// backwards. The cursor is the fastest-moving object in a screen recording.
//
// A real camera smears anything that crosses the sensor during the shutter's
// open period. A pointer flicked across a screen covers a large part of the
// frame in one frame's time, and a hard-edged arrow teleporting that distance
// between frames is what makes a drawn cursor read as a sticker. Smearing it
// along its own travel is most of what makes it read as moving instead.
//
// The blur is applied to the pointer's overlay, per axis, so a horizontal flick
// smears horizontally. A true directional blur along an arbitrary angle would
// be better and needs a rotate-blur-rotate sandwich per frame; the axis-aligned
// pair is a close enough approximation of a diagonal to be worth the enormous
// difference in cost.

const (
	// How much of one frame's travel becomes sigma. A gaussian's visible extent
	// is about 3 sigma, so a third of the travel covers roughly the distance
	// actually crossed.
	blurTravelK = 0.33
	// Below a pixel of travel per frame there is nothing to smear, and blurring
	// a resting cursor just softens it. The dead zone matters more than it
	// looks: without it every heartbeat sample carries a faint blur.
	blurMinTravel = 1.5
	// The cap is a fraction of the cursor's own size — big enough to smear, not
	// so big the cursor dissolves into a smudge with no shape at all. It is also
	// what the pointer PNG's padding is sized against, so the two must agree.
	blurMaxOfSize = 0.2
)

// pointerBlurPad is how much transparent margin the pointer image needs on each
// side for the blur to bleed into. Without it the smear is cut off square at
// the image's edge, which reads as a rectangle around the cursor.
//
// Quoted as a fraction of the cursor's size so it survives the scale command:
// the padding magnifies with the image, and so does the sigma cap it covers.
const pointerBlurPad = blurMaxOfSize * 3

// pointerBlurSigma converts a cursor velocity into per-axis gaussian sigmas.
//
// Velocity is in CANVAS pixels per second and size is the cursor's height on
// the canvas, so both halves can compute this in their own coordinate space and
// still agree — see cursor-draw.ts and the goldens in cursorblur_test.go.
//
// fps matters because the smear models one frame's exposure: the same flick
// smears half as far at 60fps as at 30, which is what a real camera does too.
func pointerBlurSigma(vx, vy, amount, size float64, fps int) (float64, float64) {
	if amount <= 0 || fps <= 0 || size <= 0 {
		return 0, 0
	}
	f := float64(fps)
	max := size * blurMaxOfSize * clampF(amount, 0, 1)
	axis := func(v float64) float64 {
		travel := math.Abs(v) / f
		if travel < blurMinTravel {
			return 0
		}
		return clampF((travel-blurMinTravel)*blurTravelK*clampF(amount, 0, 1), 0, max)
	}
	return axis(vx), axis(vy)
}
