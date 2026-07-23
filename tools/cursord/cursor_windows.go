//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	getCursorPos         = user32.NewProc("GetCursorPos")
	getAsyncKeyState     = user32.NewProc("GetAsyncKeyState")
	getSystemMetrics     = user32.NewProc("GetSystemMetrics")
)

const (
	vkLButton = 0x01
	vkRButton = 0x02
	smCxScreen = 0
	smCyScreen = 1
)

type point struct{ x, y int32 }

const platform = "windows"

func supported() bool { return true }

func buttonsSupported() bool { return true }

func cursorPos() (int, int) {
	var p point
	r, _, _ := getCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	if r == 0 {
		return 0, 0
	}
	return int(p.x), int(p.y)
}

func buttons() uint8 {
	var m uint8
	if getAsyncKeyState.Call(uintptr(vkLButton))&0x8000 != 0 {
		m |= 1
	}
	if getAsyncKeyState.Call(uintptr(vkRButton))&0x8000 != 0 {
		m |= 2
	}
	return m
}

func screenSize() (int, int) {
	w, _, _ := getSystemMetrics.Call(smCxScreen)
	h, _, _ := getSystemMetrics.Call(smCyScreen)
	return int(w), int(h)
}
