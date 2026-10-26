//go:build windows

package core

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestWindowsMediaJobConfiguresKillOnClose(t *testing.T) {
	if !ensureJob() {
		t.Fatal("media job could not be configured")
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(windows.Handle(jobHandle), windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
		t.Fatal(err)
	}
	if info.BasicLimitInformation.LimitFlags&windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
		t.Fatal("media children can outlive the parent")
	}
}
