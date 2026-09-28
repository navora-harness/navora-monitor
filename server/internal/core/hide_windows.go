//go:build windows

package core

import "syscall"

func windowsHide() syscall.SysProcAttr {
	return syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
}
