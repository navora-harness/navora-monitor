//go:build windows

package core

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
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

func scanRecordingFfmpeg() []recordingProcess {
	script := `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Select-Object ProcessId,CommandLine)`
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var processes []struct {
		ProcessID   int    `json:"ProcessId"`
		CommandLine string `json:"CommandLine"`
	}
	if json.Unmarshal([]byte(strings.TrimPrefix(string(out), "\ufeff")), &processes) != nil {
		return nil
	}
	var found []recordingProcess
	for _, process := range processes {
		args, err := windows.DecomposeCommandLine(process.CommandLine)
		if err != nil {
			continue
		}
		if output := recordingOutput(args); output != "" {
			found = append(found, recordingProcess{PID: process.ProcessID, Output: output})
		}
	}
	return found
}
