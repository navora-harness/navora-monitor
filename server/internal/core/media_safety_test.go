package core

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"
)

func isolatedCore(t *testing.T) *Core {
	t.Helper()
	root := t.TempDir()
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	// Most historical media tests exercise file processing/legacy consumers.
	// Shared-ingest tests explicitly create and clean up their input manager.
	c.ingest = nil
	c.settings.RecordingsPath = filepath.Join(root, "recordings")
	c.settings.SavedClipsPath = filepath.Join(root, "saved")
	c.settings.SnapshotsPath = filepath.Join(root, "snapshots")
	c.settings.RecordCacheEnabled = false
	c.channels = []Channel{{ID: "test", Name: "test", Enabled: true}}
	return c
}

func TestLeasedFileSurvivesCleanup(t *testing.T) {
	c := isolatedCore(t)
	path := filepath.Join(c.channelRecordDir("test"), "old.ts")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	release := c.media.leases.acquire(path)
	if err := c.removeMedia(path); err == nil {
		t.Fatal("deleted leased file")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	release()
	release()
	if err := c.removeMedia(path); err != nil {
		t.Fatal(err)
	}
}

func TestRealTimelineGapRemainsEmpty(t *testing.T) {
	segments := []Segment{{StartMs: i64ptr(1000), EndMs: i64ptr(11000)}, {StartMs: i64ptr(41000), EndMs: i64ptr(51000)}}
	got := trimSegmentEnds(segments)
	if deref(got[0].EndMs) != 11000 {
		t.Fatal("invented footage in gap")
	}
}

func TestRemoteDisabledAndPasswordRevocation(t *testing.T) {
	c := isolatedCore(t)
	token, err := c.OpenSession("navora")
	if err != nil {
		t.Fatal(err)
	}
	session, _ := c.Session(token)
	r := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	r.RemoteAddr = "192.168.1.2:1234"
	r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	w := httptest.NewRecorder()
	c.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("remote disabled: got %d", w.Code)
	}
	if err := c.SetPassword("replacement-test-password"); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Session(token); ok {
		t.Fatal("old session survived password change")
	}
	select {
	case <-session.done:
	default:
		t.Fatal("long connections not revoked")
	}
	if ListenHost("0.0.0.0", false) != "127.0.0.1" {
		t.Fatal("remote switch ignored")
	}
}

func TestLoginLimitIsBoundedPerAddress(t *testing.T) {
	c := isolatedCore(t)
	for i := 0; i < 10; i++ {
		if !c.allowLogin("127.0.0.1:1234") {
			t.Fatal("early limit")
		}
	}
	if c.allowLogin("127.0.0.1:5678") {
		t.Fatal("port bypassed limit")
	}
	if !c.allowLogin("127.0.0.2:1234") {
		t.Fatal("unrelated address blocked")
	}
}

func TestMediaQueueCancellation(t *testing.T) {
	c := isolatedCore(t)
	c.media.sem <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := c.media.exclusiveContext(ctx, func() error { t.Fatal("cancelled task ran"); return nil })
	<-c.media.sem
	if err != context.Canceled {
		t.Fatalf("got %v", err)
	}
}

// Uses the bundled FFmpeg when available; all generated media stays in TempDir.
func TestPlayableCopiesAndConcurrentExportPreserveSource(t *testing.T) {
	c := isolatedCore(t)
	name := "ffmpeg"
	platform := "linux-x64"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
		platform = "win-x64"
	}
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, name))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg unavailable")
	}
	c.settings.FFmpegPath = bin
	source := filepath.Join(c.channelRecordDir("test"), "test-20261012-100000.ts")
	cmd := exec.Command(bin, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "2", "-c:v", "libx264", "-g", "10", "-an", "-f", "mpegts", source)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	old := time.Date(2026, 10, 12, 10, 0, 2, 0, time.Local)
	if err := os.Chtimes(source, old, old); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(source)
	c.reconcileMediaMetadata()
	segments := c.ListRecordings("test")
	if len(segments) != 1 || deref(segments[0].EndMs)-deref(segments[0].StartMs) != 2000 {
		t.Fatalf("expected measured two-second segment: %+v", segments)
	}
	var paths [2]string
	var failures [2]error
	var wg sync.WaitGroup
	for i := range paths {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			paths[i], failures[i] = c.prepareShared(context.Background(), "recordings", "test", filepath.Base(source))
		}(i)
	}
	wg.Wait()
	for _, err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if paths[0] != paths[1] || paths[0] == source {
		t.Fatal("invalid derived cache identity")
	}
	if !c.normalizeTS(source) {
		t.Fatal("safe repair failed")
	}
	start := old.Add(-2 * time.Second).UnixMilli()
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, err := c.ExportRange("test", start, start+1500, "")
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	entries, err := os.ReadDir(c.channelSavedDir("test"))
	mediaCount := 0
	for _, entry := range entries {
		if isRecordingMediaFile(entry.Name()) {
			mediaCount++
		}
	}
	if err != nil || mediaCount != 2 {
		t.Fatalf("expected isolated exports: %v %d", err, len(entries))
	}
	for _, clip := range c.ListSaved("test") {
		if deref(clip.StartMs) != start {
			t.Fatal("saved clip lost capture start", clip)
		}
		probe, err := c.probeMedia(context.Background(), clip.Path)
		if err != nil {
			t.Fatal(err)
		}
		seconds, _ := strconv.ParseFloat(probe.Format.Duration, 64)
		if abs64(deref(clip.EndMs)-deref(clip.StartMs)-int64(seconds*1000)) > 1 {
			t.Fatal("saved timeline differs from media duration", clip)
		}
		if parsed, ok := parseSegmentStartMs(clip.FileName); !ok || parsed != start {
			t.Fatal("nonce filename lost original capture date")
		}
	}
	after, _ := os.ReadFile(source)
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("source was modified")
	}
	for _, path := range paths {
		if _, err := c.probeMedia(context.Background(), path); err != nil {
			t.Fatal(err)
		}
	}
	second := filepath.Join(filepath.Dir(source), "test-20261012-100032.ts")
	if err := os.WriteFile(second, before, 0600); err != nil {
		t.Fatal(err)
	}
	secondTime := old.Add(32 * time.Second)
	if err := os.Chtimes(second, secondTime, secondTime); err != nil {
		t.Fatal(err)
	}
	c.reconcileMediaMetadata()
	gapExport, _, err := c.ExportRange("test", start, start+33000, "")
	if err != nil {
		t.Fatal(err)
	}
	probe, err := c.probeMedia(context.Background(), gapExport)
	if err != nil {
		t.Fatal(err)
	}
	duration, _ := strconv.ParseFloat(probe.Format.Duration, 64)
	if duration < 2.9 || duration > 3.5 {
		t.Fatalf("gap export includes media outside selection: %.3f; inputs: %+v; start: %d; probe: %+v", duration, c.timed("test"), start, probe)
	}
}

func TestMovePreservesSameNameArchive(t *testing.T) {
	root := t.TempDir()
	src, dst := filepath.Join(root, "source.ts"), filepath.Join(root, "archive.ts")
	if err := os.WriteFile(src, []byte("source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("target"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := moveFile(src, dst); err == nil {
		t.Fatal("silently overwrote an existing archive")
	}
	got, _ := os.ReadFile(src)
	archived, _ := os.ReadFile(dst)
	if string(got) != "source" || string(archived) != "target" {
		t.Fatal("collision damaged media")
	}
	if err := os.Remove(dst); err != nil {
		t.Fatal(err)
	}
	leases := fileLeases{}
	release := leases.acquire(src)
	if err := leases.move(src, dst); err == nil {
		t.Fatal("moved leased media")
	}
	release()
	if err := leases.move(src, dst); err != nil {
		t.Fatal(err)
	}
}

func TestExportConvertsG711AudioForMP4(t *testing.T) {
	c := isolatedCore(t)
	bin := c.ffmpegPath()
	if bin == "" {
		t.Skip("FFmpeg unavailable")
	}
	source := filepath.Join(c.channelRecordDir("test"), "test-20261012-100000.mkv")
	cmd := exec.Command(bin, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
		"-t", "2", "-c:v", "libx264", "-g", "10", "-c:a", "pcm_alaw", source)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, output)
	}
	end := time.Date(2026, 10, 12, 10, 0, 2, 0, time.Local)
	if err := os.Chtimes(source, end, end); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	c.reconcileMediaMetadata()
	exported, _, err := c.ExportRange("test", end.Add(-2*time.Second).UnixMilli(), end.UnixMilli(), "")
	if err != nil {
		t.Fatal(err)
	}
	probe, err := c.probeMedia(context.Background(), exported)
	if err != nil {
		t.Fatal(err)
	}
	audio := ""
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" {
			audio = stream.CodecName
		}
	}
	if audio != "aac" {
		t.Fatalf("MP4 audio not converted: %q", audio)
	}
	after, err := os.ReadFile(source)
	if err != nil || sha256.Sum256(before) != sha256.Sum256(after) {
		t.Fatal("export modified source")
	}
}

type streamRecorder struct {
	*httptest.ResponseRecorder
	ready chan struct{}
	once  sync.Once
}

func (w *streamRecorder) Flush() {
	w.ResponseRecorder.Flush()
	w.once.Do(func() { close(w.ready) })
}

func TestDisablingRemoteClosesExistingEventStream(t *testing.T) {
	c := isolatedCore(t)
	c.settings.RemoteEnabled = true
	token, err := c.OpenSession("navora")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/events", nil).WithContext(ctx)
	request.RemoteAddr = "192.168.1.20:12345"
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	done := make(chan struct{})
	recorder := &streamRecorder{ResponseRecorder: httptest.NewRecorder(), ready: make(chan struct{})}
	go func() { c.Handler().ServeHTTP(recorder, request); close(done) }()
	select {
	case <-recorder.ready:
	case <-time.After(2 * time.Second):
		t.Fatal("event stream did not start")
	}
	next := c.Settings()
	next.RemoteEnabled = false
	if _, err := c.UpdateSettings(next); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("disabled remote stream remained active")
	}
}

func TestCanceledExportDoesNotPublish(t *testing.T) {
	c := isolatedCore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	dest := filepath.Join(t.TempDir(), "canceled.mp4")
	_, _, err := c.ExportRangeContext(ctx, "test", 1, 2000, dest)
	if err != context.Canceled {
		t.Fatalf("expected cancellation: %v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("canceled export published output")
	}
	if len(c.media.exportSlots) != 0 {
		t.Fatal("canceled export retained queue slot")
	}
}
