//go:build windows

package core

import (
	"log"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	processSetQuota       = 0x0100
	processTerminate      = 0x0001
	processSetInformation = 0x0200
)

var (
	jobOnce   sync.Once
	jobHandle syscall.Handle
	jobOK     bool

	createJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	assignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
)

func ensureJob() bool {
	jobOnce.Do(func() {
		h, _, err := createJobObjectW.Call(0, 0)
		if h == 0 {
			log.Printf("proctree: CreateJobObject failed: %v", err)
			return
		}
		jobHandle = syscall.Handle(h)
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		_, err = windows.SetInformationJobObject(
			windows.Handle(jobHandle), windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)),
		)
		if err != nil {
			log.Printf("proctree: SetInformationJobObject failed: %v", err)
			_ = syscall.CloseHandle(jobHandle)
			jobHandle = 0
			return
		}
		jobOK = true
		log.Printf("proctree: job ready (kill children on exit)")
	})
	return jobOK && jobHandle != 0
}

func prepareProcTree(cmd *exec.Cmd) {
	// CREATE_NO_WINDOW only; do not break away from jobs.
	if cmd.SysProcAttr == nil {
		attr := windowsHide()
		cmd.SysProcAttr = &attr
	}
}

func joinProcTree(pid int) {
	if pid <= 0 || !ensureJob() {
		return
	}
	const access = processSetQuota | processTerminate | processSetInformation
	h, _, err := openProcess.Call(uintptr(access), 0, uintptr(pid))
	if h == 0 {
		log.Printf("proctree: OpenProcess pid=%d failed: %v", pid, err)
		return
	}
	defer closeHandle.Call(h)
	r1, _, err := assignProcessToJobObject.Call(uintptr(jobHandle), h)
	if r1 == 0 {
		// Already in another job, or access denied — child may outlive us.
		log.Printf("proctree: AssignProcessToJobObject pid=%d failed: %v", pid, err)
		return
	}
}
