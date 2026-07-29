//go:build !darwin

package main

// No window geometry off macOS yet. Studio reads supportsSurfaces from /health
// and keeps its old behaviour where it is false: whole-screen captures get
// pointer data, window and tab shares are told plainly that they cannot.
//
// Adding a platform means implementing these two:
//   Windows — EnumWindows + GetWindowRect for windows, EnumDisplayMonitors +
//             GetMonitorInfo for displays. Both report in the same virtual
//             screen coordinates GetCursorPos uses, so no conversion is needed.
//   Linux/X11 — XQueryTree + XGetWindowAttributes, translated to root coords
//             with XTranslateCoordinates.

func supportsSurfaces() bool { return false }

func listSurfaces() []Surface { return nil }

func surfaceRect(kind string, num int) (Rect, bool) { return Rect{}, false }
