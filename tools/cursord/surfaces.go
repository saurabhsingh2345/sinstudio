package main

import (
	"fmt"
	"strconv"
	"strings"
)

// A surface is the thing being captured: a display, or a single window.
//
// It exists because "where the pointer is" and "where the pointer is IN THE
// RECORDING" are different questions, and only the first one has an answer the
// operating system will give you. cursord reports the pointer in global screen
// coordinates; a recording of a window is a rectangle somewhere inside that
// space, at an origin the browser tab doing the recording has no way to learn.
// Studio used to resolve that by refusing — pointer data was attached only to
// whole-screen captures, so a window or tab share got no auto-zoom, no click
// rings and no cursor effects at all.
//
// The missing piece is small: the rectangle. With it, every capture maps the
// same way — screen-space pointer minus the surface's origin, over the
// surface's size — and a whole display is simply the case where that rectangle
// happens to be the whole display. Multi-monitor falls out of the same change:
// the old code scaled against the MAIN display's size, so sharing a second
// monitor placed every effect somewhere it never was.
//
// The rectangle is sampled over time rather than read once, because a window
// moves. Dragging the window you are recording halfway through a take must not
// send the cursor effects sliding off it.

// Rect is a rectangle in global screen coordinates — the same space cursorPos
// reports in, which is what makes the subtraction meaningful.
type Rect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

func (r Rect) valid() bool { return r.W > 0 && r.H > 0 }

// Surface is one capturable thing, as offered to Studio for matching.
type Surface struct {
	// ID is "display:<n>" or "window:<n>" — opaque to Studio except that it is
	// what comes back to /surface.
	ID   string `json:"id"`
	Kind string `json:"kind"` // "display" | "window"
	// App owns the window ("Google Chrome"); empty for a display.
	App string `json:"app,omitempty"`
	// Title is the window's own title. macOS withholds it until the user has
	// granted Screen Recording, so it is frequently empty and must never be
	// required for matching — only for showing a human which window was picked.
	Title string `json:"title,omitempty"`
	Rect  Rect   `json:"rect"`
	// Front is front-to-back order among windows: 0 is the frontmost. A tie in
	// geometry is broken by this, because the window you just shared is
	// overwhelmingly the one you were looking at.
	Front int `json:"front"`
}

// BoundsSample is where the tracked surface was at a moment. Deduplicated the
// same way pointer samples are: a window that never moves costs two rows.
type BoundsSample struct {
	T int64 `json:"t"`
	X int   `json:"x"`
	Y int   `json:"y"`
	W int   `json:"w"`
	H int   `json:"h"`
}

func (b BoundsSample) sameRect(r Rect) bool {
	return b.X == r.X && b.Y == r.Y && b.W == r.W && b.H == r.H
}

func surfaceID(kind string, num int) string { return kind + ":" + strconv.Itoa(num) }

// parseSurfaceID splits "window:1234" back into its parts. Rejecting anything
// else keeps the platform layer from being handed arbitrary integers from a
// page, which is the one input this daemon takes from the network.
func parseSurfaceID(id string) (kind string, num int, ok bool) {
	k, n, found := strings.Cut(id, ":")
	if !found || (k != "display" && k != "window") {
		return "", 0, false
	}
	v, err := strconv.Atoi(n)
	if err != nil {
		return "", 0, false
	}
	return k, v, true
}

// findSurface resolves an id against a live enumeration, so /surface can hand
// back the App/Title/Front that Studio shows the user without asking it to
// carry them through the round trip.
func findSurface(list []Surface, id string) (Surface, bool) {
	for _, s := range list {
		if s.ID == id {
			return s, true
		}
	}
	return Surface{}, false
}

// lookupRect resolves a surface id to its current rectangle. It is the only
// per-sample cost of this whole feature, so it goes straight to the platform
// layer rather than re-enumerating every window 15 times a second.
func lookupRect(id string) (Rect, bool) {
	kind, num, ok := parseSurfaceID(id)
	if !ok {
		return Rect{}, false
	}
	return surfaceRect(kind, num)
}

func (s Surface) String() string {
	name := s.Title
	if name == "" {
		name = s.App
	}
	return fmt.Sprintf("%s (%s) %dx%d at %d,%d", s.ID, name, s.Rect.W, s.Rect.H, s.Rect.X, s.Rect.Y)
}
