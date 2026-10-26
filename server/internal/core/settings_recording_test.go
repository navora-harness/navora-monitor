package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestStorageSaveDoesNotStartIdleChannels(t *testing.T) {
	c := isolatedCore(t)
	next := c.Settings()
	next.RecordCacheEnabled = true
	next.RecordCachePath = filepath.Join(c.root, "new-cache")
	saved, err := c.UpdateSettingsAndResume(next)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.RecordCacheEnabled || !samePath(saved.RecordCachePath, next.RecordCachePath) {
		t.Fatal("storage settings not saved")
	}
	if len(c.rec.sess) != 0 || c.remembered["test"] {
		t.Fatal("saving settings started an idle channel")
	}
}

func TestStorageSaveRestartsRecordingInNewDirectory(t *testing.T) {
	platform, executable := "linux-x64", "ffmpeg"
	if runtime.GOOS == "windows" {
		platform, executable = "win-x64", "ffmpeg.exe"
	}
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, executable))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg not available")
	}
	c := isolatedCore(t)
	input := filepath.Join(c.root, "input.ts")
	if output, err := exec.Command(bin, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	c.channels[0].URL = input
	c.settings.FFmpegPath = bin
	previous := exec.Command(bin, "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-f", "null", "-")
	if err := previous.Start(); err != nil {
		t.Fatal(err)
	}
	defer previous.Process.Kill()
	go previous.Wait()
	c.rec.sess["test"] = &recSession{cmd: previous, started: time.Now(), reason: "schedule", dir: c.channelRecordDir("test")}
	defer c.rec.stopAll()
	next := c.Settings()
	next.RecordingsPath = filepath.Join(c.root, "new-archive")
	if _, err := c.UpdateSettingsAndResume(next); err != nil {
		t.Fatal(err)
	}
	c.rec.mu.Lock()
	session := c.rec.sess["test"]
	c.rec.mu.Unlock()
	if session == nil || session.cmd == previous || session.reason != "schedule" || !samePath(session.dir, filepath.Join(next.RecordingsPath, "test")) {
		t.Fatal("original session not resumed with new settings and original reason")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(session.dir)
		for _, entry := range entries {
			file, err := os.Open(filepath.Join(session.dir, entry.Name()))
			if err != nil {
				continue
			}
			info, err := file.Stat()
			file.Close()
			if err == nil && info.Size() > 0 {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("resumed recorder did not write media in new directory")
}
