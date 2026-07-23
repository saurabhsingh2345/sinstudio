//go:build darwin

package main

/*
#cgo LDFLAGS: -framework ApplicationServices
#include <ApplicationServices/ApplicationServices.h>

static void cursorPoint(double *x, double *y) {
	// CGEventCreate(NULL) snapshots the current input state; its location is
	// the pointer position in global display coordinates.
	CGEventRef e = CGEventCreate(NULL);
	CGPoint p = CGEventGetLocation(e);
	CFRelease(e);
	*x = p.x;
	*y = p.y;
}

static int buttonMask(void) {
	// Reading button state from the session event source needs no Accessibility
	// grant, unlike installing an event tap. That distinction is the whole
	// reason clicks work here without sending the user to System Settings.
	int m = 0;
	if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft))  m |= 1;
	if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonRight)) m |= 2;
	return m;
}

static void mainDisplaySize(int *w, int *h) {
	CGDirectDisplayID d = CGMainDisplayID();
	// Pixel dimensions, not points: the recording is in pixels, so matching
	// units here is what keeps a Retina display from mapping at half scale.
	*w = (int)CGDisplayPixelsWide(d);
	*h = (int)CGDisplayPixelsHigh(d);
}
*/
import "C"

const platform = "darwin"

func supported() bool { return true }

func buttonsSupported() bool { return true }

func cursorPos() (int, int) {
	var x, y C.double
	C.cursorPoint(&x, &y)
	return int(x), int(y)
}

func buttons() uint8 {
	return uint8(C.buttonMask())
}

func screenSize() (int, int) {
	var w, h C.int
	C.mainDisplaySize(&w, &h)
	return int(w), int(h)
}
