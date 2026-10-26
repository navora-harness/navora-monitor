package core

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBundledFFmpegProductionPipelines(t *testing.T) {
	platform, executable := "linux-x64", "ffmpeg"
	if runtime.GOOS == "windows" {
		platform, executable = "win-x64", "ffmpeg.exe"
	}
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, executable))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg not available")
	}
	dir := t.TempDir()
	run := func(t *testing.T, args []string, output string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, args...)
		stderr := tailBuf(4096)
		cmd.Stderr = stderr
		if output != "" {
			file, err := os.Create(output)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			cmd.Stdout = file
		}
		if err := cmd.Run(); err != nil {
			t.Fatalf("FFmpeg failed: %v: %s", err, stderr.String())
		}
	}
	input := filepath.Join(dir, "input.ts")
	run(t, []string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-bf", "0", input}, "")
	for _, transcode := range []bool{false, true} {
		name := "copy"
		if transcode {
			name = "transcode"
		}
		t.Run(name, func(t *testing.T) {
			out := filepath.Join(dir, name+".ts")
			run(t, buildMpegtsPreviewArgs(input, "tcp", transcode), out)
			run(t, []string{"-v", "error", "-xerror", "-i", out, "-f", "null", "-"}, "")
			if st, err := os.Stat(out); err != nil || st.Size() < 1880 {
				t.Fatal("preview output empty", err)
			}
		})
	}
	t.Run("record", func(t *testing.T) {
		run(t, buildSegmentRecordArgs(input, filepath.Join(dir, "record-%Y%m%d-%H%M%S.ts"), "synthetic", "tcp", 10), "")
		files, _ := filepath.Glob(filepath.Join(dir, "record-*.ts"))
		if len(files) == 0 {
			t.Fatal("no recorded segment")
		}
		for _, path := range files {
			run(t, []string{"-v", "error", "-xerror", "-i", path, "-f", "null", "-"}, "")
		}
	})
	t.Run("hls", func(t *testing.T) {
		index := filepath.Join(dir, "index.m3u8")
		run(t, buildHlsPreviewArgs(input, "tcp", index, filepath.Join(dir, "hls-%03d.ts")), "")
		playlist, err := os.ReadFile(index)
		if err != nil || !strings.Contains(string(playlist), "#EXTINF") {
			t.Fatal("empty HLS playlist", err)
		}
		files, _ := filepath.Glob(filepath.Join(dir, "hls-*.ts"))
		if len(files) == 0 {
			t.Fatal("HLS segments missing")
		}
		for _, path := range files {
			run(t, []string{"-v", "error", "-xerror", "-i", path, "-f", "null", "-"}, "")
		}
	})
}

func TestPlaybackPreparesTSWithDelayedCodecHeaders(t *testing.T) {
	platform, executable := "linux-x64", "ffmpeg"
	if runtime.GOOS == "windows" {
		platform, executable = "win-x64", "ffmpeg.exe"
	}
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, executable))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg not available")
	}
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	full := filepath.Join(t.TempDir(), "long-gop.ts")
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-g", "250", "-keyint_min", "250", "-sc_threshold", "0", "-bf", "0", full)
	hideWindow(cmd)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate fixture: %v: %s", err, output)
	}
	bytes, err := os.ReadFile(full)
	if err != nil {
		t.Fatal(err)
	}
	// Remove the initial codec headers, as happens when a camera stream starts
	// between keyframes. The next complete headers arrive around ten seconds.
	cut := (len(bytes) / 10 / 188) * 188
	name := "test-20261012-080000.ts"
	source := filepath.Join(c.channelRecordDir("test"), name)
	if err = os.WriteFile(source, bytes[cut:], 0600); err != nil {
		t.Fatal(err)
	}
	output, err := c.EnsurePlayableContext(ctx, "recordings", "test", name)
	if err != nil {
		t.Fatal(err)
	}
	probe, err := c.probeMedia(ctx, output)
	if err != nil || probe.Streams[0].Width != 160 {
		t.Fatalf("unplayable copy: %+v %v", probe, err)
	}
	decode := exec.CommandContext(ctx, bin, "-v", "error", "-xerror", "-i", output, "-f", "null", "-")
	hideWindow(decode)
	if output, err := decode.CombinedOutput(); err != nil {
		t.Fatalf("decode prepared copy: %v: %s", err, output)
	}
	after, err := os.ReadFile(source)
	if err != nil || string(after) != string(bytes[cut:]) {
		t.Fatal("preparation changed the source recording")
	}
}
