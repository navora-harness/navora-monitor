package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// Opt-in local fixture check; private recordings are never part of the repo.
func TestRealRecordingAudioClockRecovery(t *testing.T) {
	dir := os.Getenv("NAVORA_MEDIA_SAMPLE_DIR")
	if dir == "" {
		t.Skip("no local recording samples supplied")
	}
	c := isolatedCore(t)
	bin, err := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", "win-x64", "ffmpeg.exe"))
	if err != nil {
		t.Fatal(err)
	}
	c.settings.FFmpegPath = bin
	for _, sample := range []struct {
		name    string
		seconds float64
	}{
		{"20261013-015437-direct.ts", 300},
		{"20261013-085709-direct.ts", 297.9998},
		{"20261013-080627.ts", 23.2},
	} {
		t.Run(sample.name, func(t *testing.T) {
			path := filepath.Join(dir, sample.name)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			probe, err := c.probeMedia(context.Background(), path)
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(videoDurationSeconds(probe)-sample.seconds) > .2 {
				t.Fatal("incorrect video duration")
			}
			output := filepath.Join(t.TempDir(), "play.mp4")
			cmd := exec.Command(bin, playbackRemuxArgs(path, output, probe)...)
			if log, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("prepare: %v %s", err, log)
			}
			fixed, err := c.probeMedia(context.Background(), output)
			if err != nil {
				t.Fatal(err)
			}
			if math.Abs(probeSeconds(fixed.Format.Duration)-sample.seconds) > 1 {
				t.Fatalf("bad repaired duration: %s", fixed.Format.Duration)
			}
			// Decode a frame near the end; a readable header alone is insufficient.
			cmd = exec.Command(bin, "-v", "error", "-ss", strconv.FormatFloat(sample.seconds-1, 'f', 3, 64), "-i", output, "-map", "0:v:0", "-frames:v", "1", "-f", "framemd5", "-")
			if log, err := cmd.CombinedOutput(); err != nil || !bytes.Contains(log, []byte("\n0,")) {
				t.Fatalf("tail decode: %v %s", err, log)
			}
			after, err := os.ReadFile(path)
			if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
				t.Fatal("source changed")
			}
		})
	}
}
