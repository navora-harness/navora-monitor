package core

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

type blockedLiveWriter struct {
	started chan struct{}
	release chan struct{}
}

func (w *blockedLiveWriter) Header() http.Header { return http.Header{} }
func (w *blockedLiveWriter) WriteHeader(int)     {}
func (w *blockedLiveWriter) Write(b []byte) (int, error) {
	select {
	case w.started <- struct{}{}:
	default:
	}
	<-w.release
	return len(b), nil
}

func TestSlowLiveViewerDoesNotBlockOtherViewers(t *testing.T) {
	pipe := newLivePipe()
	w := &blockedLiveWriter{started: make(chan struct{}, 1), release: make(chan struct{})}
	slow := &liveClient{w: w, done: make(chan struct{}), queue: make(chan []byte, 16)}
	slow.startWriter()
	defer func() { slow.finish(); close(w.release); <-slow.writerDone }()
	pipe.add(slow)
	pipe.publish([]byte{255})
	select {
	case <-w.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not start")
	}
	rec := httptest.NewRecorder()
	fast := &liveClient{w: rec, done: make(chan struct{})}
	pipe.add(fast)
	want := make([]byte, 200)
	finished := make(chan struct{})
	go func() {
		for i := range want {
			want[i] = byte(i)
			pipe.publish([]byte{byte(i)})
		}
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("slow viewer blocked producer")
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Fatal("healthy viewer lost or reordered packets")
	}
	select {
	case <-slow.done:
	default:
		t.Fatal("overloaded viewer not disconnected")
	}
	if pipe.count() != 1 {
		t.Fatal("overloaded viewer retained")
	}
}

func TestLiveSubscriptionPreservesPreambleBoundary(t *testing.T) {
	pipe := newLivePipe()
	pipe.publish([]byte("before"))
	rec := httptest.NewRecorder()
	client := &liveClient{w: rec, done: make(chan struct{}), queue: make(chan []byte, 16)}
	pre, ok := pipe.subscribe(client)
	if !ok {
		t.Fatal("subscribe failed")
	}
	pipe.publish([]byte("after"))
	for _, b := range pre {
		if err := client.write(b); err != nil {
			t.Fatal(err)
		}
	}
	if err := client.write(<-client.queue); err != nil {
		t.Fatal(err)
	}
	if rec.Body.String() != "beforeafter" {
		t.Fatal("subscription dropped or reordered packets")
	}
}

func TestPreviewErrorRedactsCredentials(t *testing.T) {
	if os.Getenv("NAVORA_PREVIEW_TEST_CHILD") == "1" {
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestPreviewErrorRedactsCredentials$")
	cmd.Env = append(os.Environ(), "NAVORA_PREVIEW_TEST_CHILD=1")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	buf := tailBuf(4096)
	_, _ = buf.Write([]byte("Error opening rtsp://test-user:test-secret@127.0.0.1:1/main\nrtsp://test-user:test-secret@127.0.0.1:1/main: Invalid argument"))
	p := &previewMgr{sess: map[string]*prevSession{"test": {cmd: cmd, errBuf: buf, exited: true}}}
	status, _, message := p.state("test")
	if status != "error" || message == nil {
		t.Fatal("missing error")
	}
	if strings.Contains(*message, "test-secret") || strings.Contains(*message, "test-user") {
		t.Fatal("preview error exposed credentials")
	}
	if !strings.Contains(*message, "Invalid argument") {
		t.Fatal("diagnostic information lost")
	}
}

func TestLivePipeDeliversEveryChunk(t *testing.T) {
	pipe := newLivePipe()
	rec := httptest.NewRecorder()
	client := &liveClient{w: rec, rc: http.NewResponseController(rec), done: make(chan struct{})}
	if !pipe.add(client) {
		t.Fatal("pipe closed")
	}
	var want []byte
	for i := 0; i < 200; i++ {
		b := []byte{byte(i), byte(i >> 8)}
		want = append(want, b...)
		pipe.publish(b)
	}
	if got := rec.Body.Bytes(); string(got) != string(want) {
		t.Fatalf("dropped or reordered bytes: got %d want %d", len(got), len(want))
	}
	if pipe.count() != 1 {
		t.Fatal("subscriber missing")
	}
	pipe.close()
	select {
	case <-client.done:
	case <-time.After(time.Second):
		t.Fatal("close did not finish client")
	}
}

func TestLivePipePreambleForLateClient(t *testing.T) {
	pipe := newLivePipe()
	pipe.publish([]byte("pat"))
	rec := httptest.NewRecorder()
	client := &liveClient{w: rec, rc: http.NewResponseController(rec), done: make(chan struct{})}
	pre := pipe.preamble()
	for _, b := range pre {
		if err := client.write(b); err != nil {
			t.Fatal(err)
		}
	}
	if !pipe.add(client) {
		t.Fatal("pipe closed")
	}
	pipe.publish([]byte("next"))
	if got := rec.Body.String(); got != "patnext" {
		t.Fatalf("got %q", got)
	}
}

func TestReleasedPreviewPreservesOtherSessionsAndViewers(t *testing.T) {
	c := isolatedCore(t)
	now := time.Now()
	c.sessions["first"] = &Session{Expires: now.Add(time.Hour), Previews: map[string]time.Time{"shared": now}}
	c.sessions["second"] = &Session{Expires: now.Add(time.Hour), Previews: map[string]time.Time{"shared": now}}
	pipe := newLivePipe()
	c.prev.sess["shared"] = &prevSession{started: now, lastHit: now, live: pipe}
	c.TouchPreviews("first", nil)
	if c.prev.sess["shared"] == nil {
		t.Fatal("another session's preview was stopped")
	}
	viewer := &liveClient{done: make(chan struct{})}
	pipe.add(viewer)
	c.TouchPreviews("second", nil)
	if c.prev.sess["shared"] == nil {
		t.Fatal("active HTTP viewer was stopped")
	}
	pipe.remove(viewer)
	c.prev.reconcile()
	if c.prev.sess["shared"] != nil {
		t.Fatal("released preview retained reconnect grace")
	}
}
