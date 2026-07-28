//go:build darwin

package main

/*
#cgo LDFLAGS: -framework ApplicationServices -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>
#include <string.h>

// One capturable rectangle, flattened to a plain C struct so the Go side never
// touches a CoreFoundation object and never has to think about who releases it.
typedef struct {
	int  id;
	int  kind;   // 0 = display, 1 = window
	int  x, y, w, h;
	int  front;
	char app[128];
	char title[256];
} SurfaceInfo;

// The smallest window worth offering. Below this it is a tooltip, a shadow
// helper or a status item — never something a person chose to record, and
// offering them would bury the real windows in noise.
#define MIN_WINDOW_SIDE 60

static void cfstr(CFStringRef s, char *out, int n) {
	out[0] = 0;
	if (s) CFStringGetCString(s, out, n, kCFStringEncodingUTF8);
}

static int cfint(CFDictionaryRef d, CFStringRef key) {
	int v = 0;
	CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
	if (n) CFNumberGetValue(n, kCFNumberIntType, &v);
	return v;
}

// Displays and windows share one coordinate space here: CGDisplayBounds and
// kCGWindowBounds are both global, top-left origin, in points — which is the
// space CGEventGetLocation reports the pointer in. Mixing in
// CGDisplayPixelsWide (which screenSize uses, and which is a PIXEL count on a
// Retina display) would put the pointer at half scale on exactly the machines
// this is most used on.
static int listSurfaces(SurfaceInfo *out, int max) {
	int n = 0;

	CGDirectDisplayID ids[16];
	uint32_t count = 0;
	if (CGGetActiveDisplayList(16, ids, &count) == kCGErrorSuccess) {
		for (uint32_t i = 0; i < count && n < max; i++) {
			CGRect r = CGDisplayBounds(ids[i]);
			out[n].id    = (int)ids[i];
			out[n].kind  = 0;
			out[n].x     = (int)r.origin.x;
			out[n].y     = (int)r.origin.y;
			out[n].w     = (int)r.size.width;
			out[n].h     = (int)r.size.height;
			out[n].front = (int)i;
			snprintf(out[n].app, sizeof(out[n].app), "Display");
			if (CGDisplayIsMain(ids[i]))
				snprintf(out[n].title, sizeof(out[n].title), "Main display");
			else
				snprintf(out[n].title, sizeof(out[n].title), "Display %d", (int)i + 1);
			n++;
		}
	}

	// Front-to-back order, which is the order this call already returns.
	CFArrayRef list = CGWindowListCopyWindowInfo(
		kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
	if (list) {
		CFIndex m = CFArrayGetCount(list);
		for (CFIndex i = 0; i < m && n < max; i++) {
			CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
			if (!d) continue;
			// Layer 0 is an ordinary application window. Anything else is the
			// menu bar, the Dock, a screen-saver shield or a floating panel.
			if (cfint(d, kCGWindowLayer) != 0) continue;
			CFDictionaryRef bd = (CFDictionaryRef)CFDictionaryGetValue(d, kCGWindowBounds);
			CGRect r;
			if (!bd || !CGRectMakeWithDictionaryRepresentation(bd, &r)) continue;
			if (r.size.width < MIN_WINDOW_SIDE || r.size.height < MIN_WINDOW_SIDE) continue;
			out[n].id    = cfint(d, kCGWindowNumber);
			out[n].kind  = 1;
			out[n].x     = (int)r.origin.x;
			out[n].y     = (int)r.origin.y;
			out[n].w     = (int)r.size.width;
			out[n].h     = (int)r.size.height;
			out[n].front = (int)i;
			cfstr((CFStringRef)CFDictionaryGetValue(d, kCGWindowOwnerName), out[n].app, sizeof(out[n].app));
			// Absent unless Screen Recording has been granted. Studio treats it
			// as a label, never as a matching key.
			cfstr((CFStringRef)CFDictionaryGetValue(d, kCGWindowName), out[n].title, sizeof(out[n].title));
			n++;
		}
		CFRelease(list);
	}
	return n;
}

static int displayRect(int id, int *x, int *y, int *w, int *h) {
	CGDirectDisplayID ids[16];
	uint32_t count = 0;
	if (CGGetActiveDisplayList(16, ids, &count) != kCGErrorSuccess) return 0;
	for (uint32_t i = 0; i < count; i++) {
		if ((int)ids[i] != id) continue;
		CGRect r = CGDisplayBounds(ids[i]);
		*x = (int)r.origin.x; *y = (int)r.origin.y;
		*w = (int)r.size.width; *h = (int)r.size.height;
		return 1;
	}
	return 0;
}

// One window by number, rather than a full enumeration. This runs on the
// sampling loop, and enumerating every window on the machine at 15Hz to read
// one rectangle would be the most expensive thing cursord does.
static int windowRect(int id, int *x, int *y, int *w, int *h) {
	CFNumberRef num = CFNumberCreate(NULL, kCFNumberIntType, &id);
	if (!num) return 0;
	CFArrayRef arr = CFArrayCreate(NULL, (const void **)&num, 1, &kCFTypeArrayCallBacks);
	int ok = 0;
	if (arr) {
		CFArrayRef info = CGWindowListCreateDescriptionFromArray(arr);
		if (info) {
			if (CFArrayGetCount(info) > 0) {
				CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(info, 0);
				CFDictionaryRef bd = d ? (CFDictionaryRef)CFDictionaryGetValue(d, kCGWindowBounds) : NULL;
				CGRect r;
				if (bd && CGRectMakeWithDictionaryRepresentation(bd, &r)) {
					*x = (int)r.origin.x; *y = (int)r.origin.y;
					*w = (int)r.size.width; *h = (int)r.size.height;
					ok = 1;
				}
			}
			CFRelease(info);
		}
		CFRelease(arr);
	}
	CFRelease(num);
	return ok;
}
*/
import "C"

// maxSurfaces bounds one enumeration. A machine with more than this many
// on-screen windows is not one where a longer list would help anyone choose.
const maxSurfaces = 256

func supportsSurfaces() bool { return true }

func listSurfaces() []Surface {
	buf := make([]C.SurfaceInfo, maxSurfaces)
	n := int(C.listSurfaces(&buf[0], C.int(maxSurfaces)))
	out := make([]Surface, 0, n)
	for i := 0; i < n; i++ {
		s := buf[i]
		kind := "display"
		if s.kind == 1 {
			kind = "window"
		}
		out = append(out, Surface{
			ID:    surfaceID(kind, int(s.id)),
			Kind:  kind,
			App:   C.GoString(&s.app[0]),
			Title: C.GoString(&s.title[0]),
			Rect:  Rect{X: int(s.x), Y: int(s.y), W: int(s.w), H: int(s.h)},
			Front: int(s.front),
		})
	}
	return out
}

func surfaceRect(kind string, num int) (Rect, bool) {
	var x, y, w, h C.int
	var ok C.int
	if kind == "display" {
		ok = C.displayRect(C.int(num), &x, &y, &w, &h)
	} else {
		ok = C.windowRect(C.int(num), &x, &y, &w, &h)
	}
	if ok == 0 {
		return Rect{}, false
	}
	return Rect{X: int(x), Y: int(y), W: int(w), H: int(h)}, true
}
