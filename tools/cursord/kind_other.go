//go:build !darwin

package main

// Cursor-shape reporting is macOS-only for now, the same way window geometry is.
//
// Nothing here is stubbed optimistically: kindsSupported() answering false is
// what makes Studio say "this cursord cannot report cursor shapes" in the
// readiness panel instead of quietly drawing an arrow over every text field and
// leaving the user to wonder why.
//
// Windows has LoadCursor/GetCursorInfo and could be done the same way — compare
// the live HCURSOR against the standard IDC_* handles, which is actually easier
// than the macOS version because the handles are directly comparable.

func kindsSupported() bool { return false }

func cursorKind() uint8 { return 0 }
