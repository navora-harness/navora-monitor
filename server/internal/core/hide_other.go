//go:build !windows

package core

import "syscall"

func windowsHide() syscall.SysProcAttr {
	return syscall.SysProcAttr{}
}
