//go:build windows

package core

import (
	"syscall"
	"unsafe"
)

func diskUsage(path string) (free, total uint64, err error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, err
	}
	kernel := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel.NewProc("GetDiskFreeSpaceExW")
	var freeAvail, totalBytes, totalFree uint64
	r, _, e := proc.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeAvail)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		if e != nil {
			return 0, 0, e
		}
		return 0, 0, syscall.EINVAL
	}
	return freeAvail, totalBytes, nil
}
