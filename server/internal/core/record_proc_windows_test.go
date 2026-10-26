//go:build windows

package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

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
