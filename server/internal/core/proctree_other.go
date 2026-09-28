//go:build !windows

package core

import (
	"os/exec"
	"syscall"
)

func prepareProcTree(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	// Own process group so a future service manager / kill(-pgid) can reap the tree.
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func joinProcTree(pid int) {
	// Parent–child link is enough under systemd KillMode=control-group.
	_ = pid
}
