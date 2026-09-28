//go:build windows

package core

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

var (
	kernel32    = syscall.NewLazyDLL("kernel32.dll")
	openProcess = kernel32.NewProc("OpenProcess")
	closeHandle = kernel32.NewProc("CloseHandle")
)

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, _, _ := openProcess.Call(0x1000, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	_, _, _ = closeHandle.Call(h)
	return true
}

func scanRecordingFfmpeg() map[string][]int {
	script := `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ForEach-Object { $c = $_.CommandLine; if ($c -like '*record-cache*' -or $c -like '*recordings*') { if ($c -match 'cam-[a-z0-9]+') { '{0} {1}' -f $_.ProcessId, $Matches[0] } } }`
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return map[string][]int{}
	}
	found := map[string][]int{}
	for _, line := range strings.FieldsFunc(string(out), func(r rune) bool { return r == '\n' || r == '\r' }) {
		line = strings.TrimSpace(line)
		parts := strings.Fields(line)
		if len(parts) != 2 {
			continue
		}
		pid, err := strconv.Atoi(parts[0])
		if err != nil || !safeChannelID(parts[1]) {
			continue
		}
		found[parts[1]] = append(found[parts[1]], pid)
	}
	return found
}
