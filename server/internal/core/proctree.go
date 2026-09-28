package core

import "os/exec"

// prepareMediaChild configures platform process-tree / window flags before Start.
func prepareMediaChild(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	hideWindow(cmd)
	prepareProcTree(cmd)
}

// trackMediaChild attaches a started media child so it dies with this process.
func trackMediaChild(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	joinProcTree(cmd.Process.Pid)
}

// trackMediaPID attaches an already-running media process (e.g. re-adopted recorder).
func trackMediaPID(pid int) {
	if pid > 0 {
		joinProcTree(pid)
	}
}
