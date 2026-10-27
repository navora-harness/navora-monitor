package core

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSharedIngestRecoversCurrentDemandAndHonorsStop(t *testing.T) {
	bin := ingestFFmpeg(t)
	url, requests := ingestCamera(t, bin)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	c.ingest = newIngest(c)
	c.ingest.retryBase = 150 * time.Millisecond
	t.Cleanup(c.StopAllMedia)
	ch := Channel{ID: "test", Name: "recovery", URL: url, Enabled: true, SegmentTimeSec: 10}
	c.channels = []Channel{ch}
	c.sessions["watcher"] = &Session{Previews: map[string]time.Time{ch.ID: time.Now()}, Expires: time.Now().Add(time.Hour)}
	if _, err := c.StartRecord(ch.ID, "manual"); err != nil {
		t.Fatal(err)
	}
	if err := c.prev.start(ch.ID); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "preview did not start", func() bool {
		state, _, _ := c.prev.state(ch.ID)
		return state == "live"
	})
	c.ingest.mu.Lock()
	first := c.ingest.sessions[ch.ID]
	c.ingest.mu.Unlock()
	if err := first.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitIngest(t, "consumers did not observe producer failure", func() bool {
		state, _, _ := c.prev.state(ch.ID)
		return state == "error" && !c.rec.running(ch.ID)
	})
	waitIngest(t, "current recording and preview demand did not recover", func() bool {
		c.recoverSharedMedia()
		state, _, _ := c.prev.state(ch.ID)
		return state == "live" && c.rec.running(ch.ID) && requests.Load() == 2
	})
	status := c.ingest.status(ch.ID)
	if status.Starts != 2 || status.Consumers != 2 || status.ReceivedBytes == 0 {
		t.Fatalf("branches did not converge on one replacement: %+v", status)
	}
	c.ingest.mu.Lock()
	second := c.ingest.sessions[ch.ID]
	c.ingest.mu.Unlock()
	if err := second.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-second.done:
	case <-time.After(5 * time.Second):
		t.Fatal("second input did not exit")
	}
	// Explicit user stop during backoff must cancel demand, including remembered
	// manual recording state. A recovery tick must never resurrect it.
	if err := c.StopRecord(ch.ID, true); err != nil {
		t.Fatal(err)
	}
	c.ClearPreviewWant(ch.ID)
	c.prev.stop(ch.ID)
	time.Sleep(3 * c.ingest.retryBase)
	c.recoverSharedMedia()
	if requests.Load() != 2 || c.rec.running(ch.ID) {
		t.Fatal("explicit stop was undone by recovery")
	}
	c.prev.mu.Lock()
	preview := c.prev.sess[ch.ID]
	c.prev.mu.Unlock()
	if preview != nil {
		t.Fatal("stopped preview was resurrected")
	}
}

func TestSharedIngestDetectsSilentInput(t *testing.T) {
	bin := ingestFFmpeg(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp2t")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	c := isolatedCore(t)
	c.settings.FFmpegPath = bin
	m := newIngest(c)
	m.stallTimeout = 100 * time.Millisecond
	t.Cleanup(m.stopAll)
	lease, err := m.acquire(Channel{ID: "silent", URL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	m.mu.Lock()
	s := m.sessions["silent"]
	m.mu.Unlock()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("silent input was not terminated")
	}
	status := m.status("silent")
	if status.State != "reconnecting" || status.RetryAt == 0 {
		t.Fatalf("silent input did not enter recovery: %+v", status)
	}
}
