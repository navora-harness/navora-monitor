package main

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/navora-harness/navora-monitor/server/internal/core"
)

func isolatedApp(t *testing.T) *core.Core {
	t.Helper()
	root := t.TempDir()
	settings, _ := json.Marshal(map[string]any{
		"recordingsPath":     filepath.Join(root, "recordings"),
		"savedClipsPath":     filepath.Join(root, "saved"),
		"snapshotsPath":      filepath.Join(root, "snapshots"),
		"recordCacheEnabled": false,
	})
	if err := os.WriteFile(filepath.Join(root, "settings.json"), settings, 0600); err != nil {
		t.Fatal(err)
	}
	app, err := core.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func TestReadinessNotReportedWhenPortIsOccupied(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	app := isolatedApp(t)
	ready := make(chan struct{})
	if err := serveHTTPReady(app, "127.0.0.1", listener.Addr().(*net.TCPAddr).Port, ready); err == nil {
		t.Fatal("occupied port accepted")
	}
	select {
	case <-ready:
		t.Fatal("service reported ready without a listener")
	default:
	}
}

func TestShutdownWaitsForActiveHTTPHandler(t *testing.T) {
	app := isolatedApp(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		_, _ = w.Write([]byte("finished"))
	})}
	done := make(chan error, 1)
	go func() { done <- serveHTTPServer(app, listener, srv) }()
	response := make(chan string, 1)
	go func() {
		client := &http.Client{Timeout: 10 * time.Second}
		r, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			response <- "request failed"
			return
		}
		defer r.Body.Close()
		body, _ := io.ReadAll(r.Body)
		response <- string(body)
	}()
	<-started
	app.RequestShutdown()
	select {
	case <-done:
		close(release)
		t.Fatal("returned before active handler finished")
	case <-time.After(700 * time.Millisecond):
	}
	close(release)
	if body := <-response; body != "finished" {
		t.Fatalf("response interrupted: %q", body)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("shutdown did not finish")
	}
}
