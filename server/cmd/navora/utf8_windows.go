//go:build windows

package main

import "syscall"

func enableUTF8() {
	k := syscall.NewLazyDLL("kernel32.dll")
	p := k.NewProc("SetConsoleOutputCP")
	_, _, _ = p.Call(65001)
}
