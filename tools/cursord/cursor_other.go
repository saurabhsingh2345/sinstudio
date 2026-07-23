//go:build !darwin

package main

import "runtime"

// Everything below is a placeholder so the helper still builds, runs and
// answers /health on a platform it can't yet track. Reporting "supported:
// false" over HTTP is far more useful to a confused user than a binary that
// won't compile — Studio reads that flag and says cursor effects are
// unavailable here, instead of offering a feature that silently records
// nothing.
//
// Adding a platform means implementing these four functions:
//   Windows — GetCursorPos + GetAsyncKeyState (VK_LBUTTON/VK_RBUTTON)
//   Linux/X11 — XQueryPointer

const platform = runtime.GOOS

func supported() bool { return false }

func buttonsSupported() bool { return false }

func cursorPos() (int, int) { return 0, 0 }

func buttons() uint8 { return 0 }

func screenSize() (int, int) { return 0, 0 }
