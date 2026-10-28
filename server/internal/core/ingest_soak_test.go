package core

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// Opt-in duration lets CI keep the normal suite bounded while release checks
// exercise multiple recording segments and repeated preview switches.
func TestSharedIngestSoak(t *testing.T) {
	value := os.Getenv("NAVORA_INGEST_SOAK_SECONDS")
	if value == "" {
		t.Skip("set NAVORA_INGEST_SOAK_SECONDS (at least 25) for a recording soak")
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 25 {
		t.Fatal("NAVORA_INGEST_SOAK_SECONDS must be at least 25")
	}
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	c.ingest = newIngest(c)
	t.Cleanup(c.StopAllMedia)
	ch := Channel{ID: "test", Name: "soak", URL: url, Enabled: true, SegmentTimeSec: 10}
	c.channels = []Channel{ch}
	if err := c.rec.start(ch, "manual"); err != nil {
		t.Fatal(err)
	}
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "preview did not start", func() bool { state, _, _ := c.prev.state(ch.ID); return state == "live" })
	c.rec.mu.Lock()
	pid := c.rec.sess[ch.ID].cmd.Process.Pid
	c.rec.mu.Unlock()
	started := time.Now()
	nextSwitch := started.Add(5 * time.Second)
	nextProbe := started.Add(20 * time.Second)
	for time.Since(started) < time.Duration(seconds)*time.Second {
		if !c.rec.running(ch.ID) || requests.Load() != 1 {
			t.Fatal("recording or single-input invariant failed during soak")
		}
		if time.Now().After(nextSwitch) {
			c.prev.stop(ch.ID)
			if err := c.prev.start(ch.ID); err != nil {
				t.Fatal(err)
			}
			nextSwitch = time.Now().Add(5 * time.Second)
		}
		if time.Now().After(nextProbe) {
			if ok, _, msg := c.Probe(ch.ID); !ok {
				t.Fatal(msg)
			}
			nextProbe = time.Now().Add(20 * time.Second)
		}
		time.Sleep(200 * time.Millisecond)
	}
	c.rec.mu.Lock()
	sameRecorder := c.rec.sess[ch.ID].cmd.Process.Pid == pid
	c.rec.mu.Unlock()
	if !sameRecorder {
		t.Fatal("preview switches restarted recorder")
	}
	c.rec.stop(ch.ID)
	files, _ := filepath.Glob(filepath.Join(c.channelRecordDir(ch.ID), "*.ts"))
	if len(files) < 3 {
		t.Fatal("soak did not produce multiple segments")
	}
	for _, path := range files {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		output, err := exec.CommandContext(ctx, bin, "-v", "error", "-xerror", "-i", path, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-").CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("segment decode failed: %v %s", err, output)
		}
	}
	status := c.ingest.status(ch.ID)
	if requests.Load() != 1 || status.Starts != 1 {
		t.Fatal("soak opened redundant camera inputs")
	}
	t.Logf("duration=%ds camera_connections=%d segments=%d transport_bytes=%d recorder_pid_unchanged=true", seconds, requests.Load(), len(files), status.ReceivedBytes)
}
