package core

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func ingestFFmpeg(t *testing.T) string {
	t.Helper()
	platform, executable := "linux-x64", "ffmpeg"
	if runtime.GOOS == "windows" {
		platform, executable = "win-x64", "ffmpeg.exe"
	}
	bin, err := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, executable))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg not available")
	}
	return bin
}

type ingestFlushWriter struct{ http.ResponseWriter }

func (w ingestFlushWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.ResponseWriter.(http.Flusher).Flush()
	return n, err
}

// A real-time HTTP camera substitute makes upstream request counts observable,
// with real H.264/AAC packets passing through the production FFmpeg pipeline.
func ingestCamera(t *testing.T, bin string) (string, *atomic.Int32) {
	t.Helper()
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "video/mp2t")
		cmd := exec.CommandContext(r.Context(), bin, "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-bf", "0", "-c:a", "aac", "-f", "mpegts", "-muxdelay", "0", "-flush_packets", "1", "pipe:1")
		cmd.Stdout = ingestFlushWriter{w}
		prepareMediaChild(cmd)
		_ = cmd.Run()
	}))
	t.Cleanup(server.Close)
	return server.URL, requests
}

func waitIngest(t *testing.T, why string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(why)
}

func TestSharedIngestConcurrentLeasesAndIdleRelease(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	m := newIngest(c)
	m.idle = 100 * time.Millisecond
	t.Cleanup(m.stopAll)
	ch := Channel{ID: "shared", URL: url}
	const consumers = 8
	leases := make([]*ingestLease, consumers)
	errors := make([]error, consumers)
	var wg sync.WaitGroup
	for i := range leases {
		wg.Add(1)
		go func(i int) { defer wg.Done(); leases[i], errors[i] = m.acquire(ch) }(i)
	}
	wg.Wait()
	for i, err := range errors {
		if err != nil {
			t.Fatal(err)
		}
		if leases[i].URL != leases[0].URL {
			t.Fatal("concurrent consumers received different inputs")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, leases[0].URL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.CopyN(io.Discard, resp.Body, 188*10); err != nil {
		t.Fatal("no shared media received", err)
	}
	for _, lease := range leases[:consumers-1] {
		lease.Close()
		lease.Close() // release is idempotent
	}
	if _, err := io.CopyN(io.Discard, resp.Body, 188*10); err != nil {
		t.Fatal("closing other consumers interrupted surviving consumer", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("upstream opened %d times, want one", requests.Load())
	}
	m.mu.Lock()
	s := m.sessions[ch.ID]
	m.mu.Unlock()
	leases[consumers-1].Close()
	rescue, err := m.acquire(ch)
	if err != nil {
		t.Fatal(err)
	}
	if rescue.URL != leases[0].URL {
		t.Fatal("idle grace failed to reuse existing input")
	}
	time.Sleep(2 * m.idle)
	select {
	case <-s.done:
		t.Fatal("cancelled idle timer stopped an active input")
	default:
	}
	rescue.Close()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("unused input did not stop")
	}
	m.stopAll()
	if lease, err := m.acquire(ch); err == nil {
		lease.Close()
		t.Fatal("closed manager accepted a new input")
	}
}

func TestSharedIngestRecordingAndPreviewUseOneCamera(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	c.ingest = newIngest(c)
	t.Cleanup(c.StopAllMedia)
	ch := Channel{ID: "test", Name: "shared", URL: url, PreviewURL: "http://127.0.0.1:1/must-not-be-opened", Enabled: true, SegmentTimeSec: 10}
	c.channels = []Channel{ch}
	if err := c.rec.start(ch, "manual"); err != nil {
		t.Fatal(err)
	}
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "preview did not receive shared input", func() bool {
		c.prev.mu.Lock()
		defer c.prev.mu.Unlock()
		s := c.prev.sess[ch.ID]
		return s != nil && !s.starting && !s.exited && len(s.live.preamble()) > 0
	})
	waitIngest(t, "recording did not receive shared input", func() bool {
		files, _ := filepath.Glob(filepath.Join(c.channelRecordDir(ch.ID), "*.ts"))
		for _, path := range files {
			if st, err := os.Stat(path); err == nil && st.Size() > 188*20 {
				return true
			}
		}
		return false
	})
	c.ingest.mu.Lock()
	s := c.ingest.sessions[ch.ID]
	pid := s.cmd.Process.Pid
	c.ingest.mu.Unlock()
	c.prev.stop(ch.ID)
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "restarted preview did not join existing input", func() bool {
		c.prev.mu.Lock()
		defer c.prev.mu.Unlock()
		return c.prev.sess[ch.ID] != nil && !c.prev.sess[ch.ID].starting && !c.prev.sess[ch.ID].exited
	})
	c.rec.stop(ch.ID)
	select {
	case <-s.done:
		t.Fatal("stopping recording stopped input while preview was active")
	default:
	}
	if requests.Load() != 1 || s.cmd.Process.Pid != pid {
		t.Fatalf("record/preview restarted the camera input; requests=%d", requests.Load())
	}
	files, _ := filepath.Glob(filepath.Join(c.channelRecordDir(ch.ID), "*.ts"))
	if len(files) == 0 {
		t.Fatal("recorded segment missing")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Decode video AND audio to verify the shared transport preserved both tracks.
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-i", files[0], "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("shared recording is not decodable: %v: %s", err, output)
	}
}

func TestSharedIngestReplacesFailedProducer(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	m := newIngest(c)
	t.Cleanup(m.stopAll)
	ch := Channel{ID: "recover", URL: url}
	first, err := m.acquire(ch)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	waitIngest(t, "producer did not connect", func() bool { return requests.Load() == 1 })
	m.mu.Lock()
	old := m.sessions[ch.ID]
	m.mu.Unlock()
	if err := old.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-old.done:
	case <-time.After(5 * time.Second):
		t.Fatal("failed producer was not reaped")
	}
	second, err := m.acquire(ch)
	if err == nil {
		second.Close()
		t.Fatal("failed producer was retried without backoff")
	}
	status := m.status(ch.ID)
	if status.State != "reconnecting" || status.Starts != 1 || status.RetryAt == 0 {
		t.Fatalf("missing recovery status: %+v", status)
	}
	waitIngest(t, "replacement could not be acquired after backoff", func() bool {
		second, err = m.acquire(ch)
		return err == nil
	})
	defer second.Close()
	third, err := m.acquire(ch)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	if second.URL == first.URL || second.URL != third.URL {
		t.Fatal("consumers did not converge on one replacement input")
	}
	waitIngest(t, "replacement did not connect", func() bool { return requests.Load() == 2 })
	first.Close() // stale lease must not close the replacement session
	m.mu.Lock()
	current := m.sessions[ch.ID]
	refs := current.refs
	m.mu.Unlock()
	if refs != 2 {
		t.Fatalf("stale release changed replacement references: %d", refs)
	}
}

func TestIngestRetryBudgetGrowsAndCaps(t *testing.T) {
	m := newIngest(nil)
	h := &ingestHistory{}
	now := time.Now()
	for i, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second} {
		m.failed(h, now, "rtsp://user:secret@camera/main")
		if got := h.retryAt.Sub(now); got != want {
			t.Fatalf("attempt %d: delay %s, want %s", i, got, want)
		}
		if strings.Contains(h.lastError, "secret") {
			t.Fatal("credentials leaked in retry status")
		}
	}
}

func TestIngestArgsPreserveOriginalAudioAndVideo(t *testing.T) {
	args := strings.Join(buildIngestArgs("rtsp://camera/main", "tcp"), " ")
	for _, want := range []string{"-rtsp_transport tcp", "-map 0:v:0", "-map 0:a:0?", "-c copy", "-f mpegts"} {
		if !strings.Contains(args, want) {
			t.Fatal("missing", want, "in", args)
		}
	}
	if strings.Contains(args, "-an ") || strings.Contains(args, "libx264") || strings.Contains(args, "nobuffer") {
		t.Fatal("shared input must not discard audio, transcode or drop probe packets", args)
	}
}
