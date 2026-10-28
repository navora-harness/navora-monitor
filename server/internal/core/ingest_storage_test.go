package core

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestSharedIngestSlowConsumerCannotBlockHealthyConsumer(t *testing.T) {
	pipe := newLivePipe()
	pipe.join = &tsJoinCache{}
	pipe.publish(bytes.Join([][]byte{testTSTable(0), testTSTable(ingestPMTPID), testTSPacket(ingestVideoPID, true)}, nil))
	w := &blockedLiveWriter{started: make(chan struct{}, 1), release: make(chan struct{})}
	slow := &liveClient{w: w, done: make(chan struct{}), queue: make(chan []byte, 2)}
	pipe.subscribe(slow)
	slow.startWriter()
	defer func() { slow.finish(); close(w.release); <-slow.writerDone }()
	fastOutput := httptest.NewRecorder()
	fast := &liveClient{w: fastOutput, done: make(chan struct{})}
	pipe.subscribe(fast)
	packet := testTSPacket(ingestVideoPID, false)
	pipe.publish(packet)
	select {
	case <-w.started:
	case <-time.After(time.Second):
		t.Fatal("slow consumer did not start")
	}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 128; i++ {
			pipe.publish(packet)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("slow recorder blocked media input")
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("overloaded consumer not disconnected")
	}
	if !bytes.Equal(fastOutput.Body.Bytes(), bytes.Repeat(packet, 129)) {
		t.Fatal("healthy branch lost or reordered media")
	}
}

func TestSharedIngestOutputFailureBackoffDoesNotStopPreview(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	c.ingest = newIngest(c)
	t.Cleanup(c.StopAllMedia)
	// An ordinary file occupying the channel directory deterministically causes
	// real FFmpeg write failure, without filling or modifying the user's disk.
	root := c.recordingsRoot()
	if err := os.WriteFile(filepath.Join(root, "test"), []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	ch := Channel{ID: "test", Name: "output-failure", Enabled: true, URL: url, SegmentTimeSec: 10}
	c.channels = []Channel{ch}
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		if err := c.rec.start(ch, "manual"); err != nil {
			t.Fatal(err)
		}
		waitIngest(t, "write failure not detected", func() bool { state, _, _, _, _ := c.rec.state(ch.ID); return state == "error" })
		c.rec.mu.Lock()
		failed := c.rec.sess[ch.ID]
		failures, retryAt := failed.failures, failed.retryAt
		c.rec.mu.Unlock()
		if failures != attempt || time.Until(retryAt) <= 0 {
			t.Fatal("missing output retry budget")
		}
		if err := c.rec.start(ch, "manual"); err == nil {
			t.Fatal("write failure bypassed backoff")
		}
		waitIngest(t, "preview stopped with failed recorder", func() bool { state, _, _ := c.prev.state(ch.ID); return state == "live" })
		if requests.Load() != 1 {
			t.Fatal("output failure reopened camera")
		}
		if attempt == 1 {
			waitIngest(t, "output retry did not become due", func() bool { return !time.Now().Before(retryAt) })
		}
	}
	if err := os.Remove(filepath.Join(root, "test")); err != nil {
		t.Fatal(err)
	}
	// Explicit stop resets failed output state before a repaired target restarts.
	c.rec.stop(ch.ID)
	if err := c.rec.start(ch, "manual"); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "repaired output did not write", func() bool {
		files, _ := filepath.Glob(filepath.Join(root, "test", "*.ts"))
		for _, p := range files {
			st, e := os.Stat(p)
			if e == nil && st.Size() > 1880 {
				return true
			}
		}
		return false
	})
	if requests.Load() != 1 {
		t.Fatal("repair restarted camera")
	}
}

func TestSharedIngestStorageSwitchAndCriticalPauseKeepInput(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	c.ingest = newIngest(c)
	t.Cleanup(c.StopAllMedia)
	ch := Channel{ID: "test", Name: "storage", Enabled: true, URL: url, SegmentTimeSec: 10}
	c.channels = []Channel{ch}
	if _, err := c.StartRecord(ch.ID, "manual"); err != nil {
		t.Fatal(err)
	}
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "preview not ready", func() bool { state, _, _ := c.prev.state(ch.ID); return state == "live" })
	next := c.Settings()
	next.RecordCacheEnabled = true
	next.RecordCachePath = filepath.Join(c.root, "switched-cache")
	next.RecordingsPath = filepath.Join(c.root, "switched-archive")
	if _, err := c.UpdateSettingsAndResume(next); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "switched cache did not receive media", func() bool {
		files, _ := filepath.Glob(filepath.Join(next.RecordCachePath, ch.ID, "*.ts"))
		for _, p := range files {
			if st, err := os.Stat(p); err == nil && st.Size() > 1880 {
				return true
			}
		}
		return false
	})
	// Drive the same cached disk state consumed by the production protection lane.
	c.media.mu.Lock()
	c.media.disk = diskSnap{at: time.Now(), info: DiskInfo{RecordingBlocked: true}}
	c.media.mu.Unlock()
	c.enforceRecordingStorage()
	if c.rec.running(ch.ID) {
		t.Fatal("critical storage did not pause recording")
	}
	state, _, _ := c.prev.state(ch.ID)
	if state != "live" || requests.Load() != 1 {
		t.Fatal("storage pause interrupted shared input")
	}
	c.media.mu.Lock()
	c.media.disk = diskSnap{at: time.Now(), info: DiskInfo{}}
	c.media.mu.Unlock()
	c.recoverSharedMedia()
	if !c.rec.running(ch.ID) || requests.Load() != 1 {
		t.Fatal("storage recovery did not reuse input")
	}
	c.rec.stop(ch.ID)
	files, _ := filepath.Glob(filepath.Join(next.RecordingsPath, ch.ID, "*.ts"))
	if len(files) == 0 {
		t.Fatal("finished cache segments were not archived")
	}
	for _, p := range files {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		out, err := exec.CommandContext(ctx, bin, "-v", "error", "-xerror", "-i", p, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-").CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("archived segment not decodable: %v %s", err, out)
		}
	}
}

func TestIngestNormalizesCameraAudioCodecs(t *testing.T) {
	bin := ingestFFmpeg(t)
	for _, codec := range []string{"aac", "pcm_alaw", "pcm_mulaw"} {
		t.Run(codec, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			dir := t.TempDir()
			input := filepath.Join(dir, "source.nut")
			output := filepath.Join(dir, "normalized.ts")
			args := []string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-bf", "0", "-c:a", codec, "-f", "nut", input}
			if out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput(); err != nil {
				t.Fatalf("source: %v %s", err, out)
			}
			cmd := exec.CommandContext(ctx, bin, buildIngestArgs(input, "tcp")...)
			file, err := os.Create(output)
			if err != nil {
				t.Fatal(err)
			}
			cmd.Stdout = file
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			err = cmd.Run()
			file.Close()
			if err != nil {
				t.Fatalf("normalize: %v %s", err, stderr.Bytes())
			}
			if out, err := exec.CommandContext(ctx, bin, "-v", "error", "-xerror", "-i", output, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-").CombinedOutput(); err != nil {
				t.Fatalf("audio lost or invalid: %v %s", err, out)
			}
		})
	}
}
