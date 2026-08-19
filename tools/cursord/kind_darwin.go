//go:build darwin

package main

/*
// The preamble is Objective-C, not C — cgo compiles it as C unless told
// otherwise, and NSCursor has no C spelling. ARC keeps the local objects
// managed; nothing here outlives its autorelease pool but the hash table,
// which is plain C.
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework AppKit -framework Foundation
#import <AppKit/AppKit.h>

// Which system cursor is on screen.
//
// The pointer's SHAPE is the other half of what it is doing. A tutorial that
// draws an arrow while the real cursor was an I-beam over a text field, or a
// pointing hand over a link, is telling the viewer something false about the
// interface — and those two shapes are most of what a screen recording of a web
// app contains.
//
// There is no public API that names the current cursor. NSCursor's
// currentSystemCursor hands back the cursor as drawn, so it is identified by
// comparing its picture against the standard ones. That has two traps, both
// found by running it rather than by reading the docs:
//
//  1. In a plain command-line process, [NSCursor arrowCursor].image is 0x0 —
//     AppKit has not loaded its cursor assets, so arrow and I-beam both hash to
//     "empty" and match each other. NSApplicationLoad() fixes it, and unlike
//     [NSApplication sharedApplication] it does not turn cursord into something
//     with a Dock icon that can steal focus.
//  2. The live cursor is drawn at the user's cursor SIZE, which the accessibility
//     settings can enlarge, while the reference images are at their natural
//     size. So both sides are rendered into the same small box before hashing,
//     which makes the comparison scale-invariant. Hashing TIFFRepresentation
//     directly works only until someone touches that slider.

typedef struct { unsigned long long h; int kind; } kindRef;

// Kinds. Mirrors cursorKind in Go and CursorKind in the frontend.
enum { KUnknown = 0, KArrow = 1, KText = 2, KHand = 3, KCross = 4, KResizeH = 5, KResizeV = 6 };

static kindRef refs[16];
static int nrefs = 0;

// signature renders an image into a fixed 24x24 alpha grid, quantised to four
// levels, and hashes it. Coarse on purpose: the point is to tell an arrow from
// a hand, not to detect a one-pixel difference between two renderings of the
// same arrow at different scales.
static unsigned long long signature(NSImage *img) {
	if (!img || img.size.width <= 0) return 0;
	NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
	    initWithBitmapDataPlanes:NULL pixelsWide:24 pixelsHigh:24
	    bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
	    colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
	if (!rep) return 0;
	NSGraphicsContext *ctx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
	if (!ctx) return 0;
	[NSGraphicsContext saveGraphicsState];
	[NSGraphicsContext setCurrentContext:ctx];
	[[NSColor clearColor] set];
	NSRectFill(NSMakeRect(0, 0, 24, 24));
	[img drawInRect:NSMakeRect(0, 0, 24, 24) fromRect:NSZeroRect
	      operation:NSCompositingOperationSourceOver fraction:1.0];
	[NSGraphicsContext restoreGraphicsState];

	unsigned char *d = [rep bitmapData];
	if (!d) return 0;
	unsigned long long h = 1469598103934665603ULL;
	for (int i = 0; i < 24 * 24; i++) {
		unsigned char a = d[i * 4 + 3] >> 6;
		h ^= a;
		h *= 1099511628211ULL;
	}
	return h;
}

static void addRef(NSCursor *c, int kind) {
	if (!c || nrefs >= 16) return;
	unsigned long long h = signature([c image]);
	if (h == 0) return;
	// First writer wins, so the kinds listed first are the ones a collision
	// resolves to. Arrow leads for that reason.
	for (int i = 0; i < nrefs; i++) if (refs[i].h == h) return;
	refs[nrefs].h = h;
	refs[nrefs].kind = kind;
	nrefs++;
}

static int kindsReady = 0;

static void kindInit(void) {
	@autoreleasepool {
		NSApplicationLoad();
		addRef([NSCursor arrowCursor], KArrow);
		addRef([NSCursor IBeamCursor], KText);
		addRef([NSCursor pointingHandCursor], KHand);
		// An open or closed hand is still a hand as far as the drawn cursor is
		// concerned; splitting them would need two more shapes to say something
		// a viewer does not read.
		addRef([NSCursor openHandCursor], KHand);
		addRef([NSCursor closedHandCursor], KHand);
		addRef([NSCursor crosshairCursor], KCross);
		addRef([NSCursor resizeLeftRightCursor], KResizeH);
		addRef([NSCursor resizeLeftCursor], KResizeH);
		addRef([NSCursor resizeRightCursor], KResizeH);
		addRef([NSCursor resizeUpDownCursor], KResizeV);
		addRef([NSCursor resizeUpCursor], KResizeV);
		addRef([NSCursor resizeDownCursor], KResizeV);
		// Two or fewer means AppKit gave us nothing usable and every live read
		// would answer "unknown"; better to report the feature as absent.
		kindsReady = nrefs > 2;
	}
}

static int kindsAvailable(void) { return kindsReady; }

static int currentKind(void) {
	if (!kindsReady) return KUnknown;
	@autoreleasepool {
		NSCursor *c = [NSCursor currentSystemCursor];
		if (!c) return KUnknown;
		unsigned long long h = signature([c image]);
		for (int i = 0; i < nrefs; i++) if (refs[i].h == h) return refs[i].kind;
		// An app with its own cursor art matches nothing, and saying so is the
		// honest answer — Studio then draws its default rather than guessing.
		return KUnknown;
	}
}
*/
import "C"

import (
	"runtime"
	"sync"
)

// kindOnce keeps the AppKit work on ONE thread for the process's life.
//
// AppKit is not thread-safe, and the sampling loop is a goroutine the Go
// runtime may move between OS threads whenever it likes. So the reads happen on
// a single locked thread of their own, fed by a channel, rather than wherever
// the scheduler happens to be — the difference between working and crashing
// somewhere unrelated, hours in.
var (
	kindOnce sync.Once
	kindReq  chan chan uint8
	kindOK   bool
)

func startKindThread() {
	kindReq = make(chan chan uint8)
	ready := make(chan bool)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		C.kindInit()
		ready <- C.kindsAvailable() != 0
		for reply := range kindReq {
			reply <- uint8(C.currentKind())
		}
	}()
	kindOK = <-ready
}

func kindsSupported() bool {
	kindOnce.Do(startKindThread)
	return kindOK
}

// cursorKind reports which system cursor is showing, as a code the sidecar and
// both renderers share. 0 means "not known", which every consumer treats as the
// default arrow.
func cursorKind() uint8 {
	kindOnce.Do(startKindThread)
	if !kindOK {
		return 0
	}
	reply := make(chan uint8, 1)
	kindReq <- reply
	return <-reply
}
