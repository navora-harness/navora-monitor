package main

import (
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/navora-harness/navora-monitor/server/internal/core"
)

func TestRemoteAccessSwitchKeepsHTTPAlive(t *testing.T) {
	initial, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := initial.Addr().(*net.TCPAddr).Port
	l := &switchListener{current: initial}
	app := isolatedApp(t)
	app.SetRemoteSwitch(func(enabled bool) error { return l.replace(core.ListenAddr(core.ListenHost("", enabled), port)) })
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "alive") })}
	done := make(chan error, 1)
	go func() { done <- server.Serve(l) }()
	defer func() { _ = server.Close(); <-done }()
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	for _, enabled := range []bool{true, false, true, false} {
		next := app.Settings()
		next.RemoteEnabled = enabled
		if _, err := app.UpdateSettings(next); err != nil {
			t.Fatal(err)
		}
		host := l.Addr().(*net.TCPAddr).IP
		if enabled && !host.IsUnspecified() {
			t.Fatal("LAN listener not enabled", host)
		}
		if !enabled && !host.IsLoopback() {
			t.Fatal("LAN listener not disabled", host)
		}
		resp, err := client.Get("http://127.0.0.1:" + itoa(port))
		if err != nil {
			t.Fatal("HTTP stopped on switch", err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != "alive" {
			t.Fatal("unexpected response")
		}
	}
}

func TestListenerFailedSwitchRestoresOriginalAddress(t *testing.T) {
	initial, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := &switchListener{current: initial}
	defer l.Close()
	previous := initial.Addr().String()
	if err := l.replace("invalid address"); err == nil {
		t.Fatal("invalid address accepted")
	}
	if l.Addr().String() != previous {
		t.Fatal("original listener not restored")
	}
	conn, err := net.DialTimeout("tcp", previous, time.Second)
	if err != nil {
		t.Fatal("original listener inaccessible", err)
	}
	conn.Close()
}
