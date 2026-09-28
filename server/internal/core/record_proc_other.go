//go:build !windows

package core

import "syscall"

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func scanRecordingFfmpeg() map[string][]int { return map[string][]int{} }
