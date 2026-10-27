//go:build windows

package core

import (
	"golang.org/x/sys/windows"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestWindowsProcessAliveHelper(t *testing.T) {
	if os.Getenv("NAVORA_TEST_PROCESS_WAIT") != "1" {
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
	os.Exit(0)
}

func TestWindowsExitedProcessWithOpenHandleIsNotAlive(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestWindowsProcessAliveHelper$")
	cmd.Env = append(os.Environ(), "NAVORA_TEST_PROCESS_WAIT=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); cmd.Process.Kill(); cmd.Wait() }()
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if !processAlive(cmd.Process.Pid) {
		t.Fatal("running process was reported dead")
	}
	stdin.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	// Retain h so the terminated kernel process object still exists.
	if processAlive(cmd.Process.Pid) {
		t.Fatal("terminated process with a retained handle was reported alive")
	}
}

func TestWindowsProcessScanPreservesQuotedUnicodeOutput(t *testing.T) {
	c := isolatedCore(t)
	bin := c.ffmpegPath()
	if bin == "" {
		t.Skip("FFmpeg unavailable")
	}
	root := filepath.Join(t.TempDir(), "隔离录像 with spaces")
	dir := filepath.Join(root, "cam-test")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "camera-"+segmentStrftimeSuffix)
	cmd := exec.Command(bin, "-hide_banner", "-loglevel", "error", "-re",
		"-f", "lavfi", "-i", "color=size=160x90:rate=10", "-t", "20",
		"-c:v", "libx264", "-an", "-f", "segment", "-segment_format", "mpegts", "-strftime", "1", output)
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	found := recordingsForRoots(scanRecordingFfmpeg(), []string{root})
	if pids := found["cam-test"]; len(pids) != 1 || pids[0] != cmd.Process.Pid {
		t.Fatalf("Unicode/space output path not recognized: %v", found)
	}
	if unrelated := recordingsForRoots(scanRecordingFfmpeg(), []string{root + "-other"}); len(unrelated) != 0 {
		t.Fatalf("unrelated root claimed a real FFmpeg process: %v", unrelated)
	}
}
