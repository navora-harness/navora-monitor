package core

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func updateTestCore(t *testing.T) *Core {
	t.Helper()
	c, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.UpsertChannel(Channel{ID: "test", Name: "test", URL: "rtsp://127.0.0.1:1/test", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func importTestBundle(t *testing.T, c *Core, settings Settings, channels []Channel, parts map[string]bool) error {
	t.Helper()
	b, err := json.Marshal(bundle{Kind: "navora-monitor-config", Settings: settings, Channels: channels, Layout: defaultLayout()})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "import.json")
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = c.ApplyConfig(path, parts, false, nil)
	return err
}

func blockConfigWrite(t *testing.T, c *Core, name string) {
	t.Helper()
	path := filepath.Join(c.root, name)
	if _, err := os.Stat(path); err == nil {
		if err := os.Rename(path, path+".backup"); err != nil {
			t.Fatal(err)
		}
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
}

func TestChannelAndGroupWriteFailureRestoresCommittedDocument(t *testing.T) {
	for _, operation := range []string{"upsert", "batch", "remove", "rename", "move"} {
		t.Run(operation, func(t *testing.T) {
			c := updateTestCore(t)
			ch := c.Channels()[0]
			ch.Group = "before"
			if _, err := c.UpsertChannel(ch); err != nil {
				t.Fatal(err)
			}
			before, groups := c.Channels(), c.GroupOrder()
			blockConfigWrite(t, c, "channels.json")
			var err error
			switch operation {
			case "upsert":
				ch.Name = "changed"
				_, err = c.UpsertChannel(ch)
			case "batch":
				ch.Group = "after"
				_, err = c.UpsertChannels([]Channel{ch})
			case "remove":
				_, err = c.RemoveChannels([]string{ch.ID})
			case "rename":
				_, err = c.RenameGroup("before", "after")
			case "move":
				_, err = c.MoveChannelsBefore([]string{ch.ID}, "after", nil)
			}
			if err == nil || !reflect.DeepEqual(before, c.Channels()) || !reflect.DeepEqual(groups, c.GroupOrder()) {
				t.Fatalf("failed write changed committed state: %v", err)
			}
		})
	}
}

func TestBatchRejectsInvalidRowsWithoutPartialSave(t *testing.T) {
	c := updateTestCore(t)
	before := c.Channels()
	valid := before[0]
	valid.Name = "changed"
	if _, err := c.UpsertChannels([]Channel{valid, {ID: "../bad"}}); err == nil {
		t.Fatal("invalid batch accepted")
	}
	if !reflect.DeepEqual(before, c.Channels()) {
		t.Fatal("part of invalid batch saved")
	}
}

func TestImportUsesListenerSwitchAndRevokesSessions(t *testing.T) {
	c := updateTestCore(t)
	token, err := c.OpenSession(c.Settings().RemoteUsername)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	session := c.sessions[token]
	c.mu.Unlock()
	next := c.Settings()
	next.RemoteEnabled = true
	next.RemoteUsername = "imported"
	called := false
	c.SetRemoteSwitch(func(enabled bool) error { called = enabled; return nil })
	if err := importTestBundle(t, c, next, nil, map[string]bool{"settings": true}); err != nil {
		t.Fatal(err)
	}
	if !called || c.Settings().RemoteUsername != "imported" {
		t.Fatal("import bypassed settings lifecycle")
	}
	select {
	case <-session.done:
	default:
		t.Fatal("old session was not revoked")
	}
}

func TestImportFailureRestoresSettingsAndListener(t *testing.T) {
	for _, file := range []string{"channels.json", "settings.json", "layout.json"} {
		t.Run(file, func(t *testing.T) {
			c := updateTestCore(t)
			previous := c.Settings()
			channels := c.Channels()
			var switches []bool
			c.SetRemoteSwitch(func(enabled bool) error { switches = append(switches, enabled); return nil })
			blockConfigWrite(t, c, file)
			next := previous
			next.RemoteEnabled = true
			changed := channels[0]
			changed.Name = "changed"
			err := importTestBundle(t, c, next, []Channel{changed}, map[string]bool{"settings": true, "channels": true, "layout": true})
			if err == nil || c.Settings() != previous || !reflect.DeepEqual(channels, c.Channels()) {
				t.Fatalf("failed import retained changes: %v", err)
			}
			if len(switches) < 2 || switches[len(switches)-1] {
				t.Fatalf("listener not restored: %v", switches)
			}
		})
	}
}

func TestChannelMetadataKeepsMediaAndDisableStopsPreview(t *testing.T) {
	c := updateTestCore(t)
	pipe := newLivePipe()
	session := &prevSession{live: pipe, started: time.Now()}
	c.prev.sess["test"] = session
	ch := c.Channels()[0]
	ch.Name = "new name"
	ch.Group = "new group"
	if _, err := c.UpsertChannel(ch); err != nil {
		t.Fatal(err)
	}
	if c.prev.sess["test"] != session {
		t.Fatal("metadata edit interrupted preview")
	}
	ch.Enabled = false
	if _, err := c.UpsertChannel(ch); err != nil {
		t.Fatal(err)
	}
	if c.prev.sess["test"] != nil {
		t.Fatal("disabled channel kept preview")
	}
	pipe.mu.Lock()
	closed := pipe.closed
	pipe.mu.Unlock()
	if !closed {
		t.Fatal("disabled stream was not closed")
	}
}

func TestMalformedMutationRequestsDoNotRemoveChannels(t *testing.T) {
	c := updateTestCore(t)
	token, err := c.OpenSession(c.Settings().RemoteUsername)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"ids":["test"]} trailing`, `{"ids":["test"],"unused":`, `null`, `[]`, `{"ids":["test"]} {}`} {
		r := httptest.NewRequest(http.MethodPost, "/api/channels/remove", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		w := httptest.NewRecorder()
		c.Handler().ServeHTTP(w, r)
		if w.Code != 400 || len(c.Channels()) != 1 {
			t.Fatalf("malformed mutation executed: %q %d", body, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/record/group/stop", strings.NewReader(`{}`))
	c.handleGroupRecord(w, r, false)
	if w.Code != 400 {
		t.Fatal("missing group accepted")
	}
}

func TestScanCancellationAndScopeValidation(t *testing.T) {
	c := updateTestCore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := c.ScanContext(ctx, "lan", "127.0.0.1/32", "", "", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled scan succeeded: %v", err)
	}
	for _, cidr := range []string{"invalid", "::1/128", "10.0.0.0/8"} {
		if _, err := scanHosts(cidr); err == nil {
			t.Fatalf("unsupported scope accepted: %s", cidr)
		}
	}
	hosts, err := scanHosts("192.168.0.0/23")
	if err != nil || len(hosts) != 510 || hosts[254] != "192.168.0.255" || hosts[255] != "192.168.1.0" {
		t.Fatal("valid /23 was truncated or skipped interior addresses", err)
	}
	for _, cidr := range []string{"127.0.0.1/32", "127.0.0.0/31"} {
		hosts, err := scanHosts(cidr)
		if err != nil || len(hosts) == 0 {
			t.Fatal("small subnet skipped", err)
		}
	}
	main, _ := rtspPair("hikvision", "127.0.0.1", 554, "user@name", "p:a@ss/#", 1)
	u, err := url.Parse(main)
	if err != nil {
		t.Fatal(err)
	}
	pass, _ := u.User.Password()
	if u.User.Username() != "user@name" || pass != "p:a@ss/#" || u.Hostname() != "127.0.0.1" {
		t.Fatal("scan credentials corrupted URL")
	}
}

func TestChannelEditRestartsRecordingAndPreservesReason(t *testing.T) {
	platform, executable := "linux-x64", "ffmpeg"
	if runtime.GOOS == "windows" {
		platform, executable = "win-x64", "ffmpeg.exe"
	}
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "vendor", "ffmpeg", platform, executable))
	if _, err := os.Stat(bin); err != nil {
		t.Skip("bundled FFmpeg not available")
	}
	c := updateTestCore(t)
	input := filepath.Join(c.root, "new-input.ts")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, bin, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", input).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	c.settings.FFmpegPath = bin
	previous := exec.Command(bin, "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-f", "null", "-")
	prepareMediaChild(previous)
	if err := previous.Start(); err != nil {
		t.Fatal(err)
	}
	old := &recSession{cmd: previous, started: time.Now(), reason: "schedule", dir: c.channelRecordDir("test"), done: make(chan struct{})}
	c.rec.sess["test"] = old
	go func() {
		_ = previous.Wait()
		c.rec.mu.Lock()
		old.exited = true
		c.rec.mu.Unlock()
		close(old.done)
	}()
	t.Cleanup(c.rec.stopAll)
	ch := c.Channels()[0]
	ch.Name = "renamed"
	if _, err := c.UpsertChannel(ch); err != nil {
		t.Fatal(err)
	}
	if c.rec.sess["test"] != old {
		t.Fatal("name edit interrupted recording")
	}
	blockConfigWrite(t, c, "channels.json")
	ch.URL = input
	ch.SegmentTimeSec = 20
	if _, err := c.UpsertChannel(ch); err == nil {
		t.Fatal("write failure accepted")
	}
	if c.rec.sess["test"] != old || !processAlive(previous.Process.Pid) {
		t.Fatal("failed edit interrupted recording")
	}
	path := filepath.Join(c.root, "channels.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".backup", path); err != nil {
		t.Fatal(err)
	}
	if _, err := c.UpsertChannel(ch); err != nil {
		t.Fatal(err)
	}
	c.rec.mu.Lock()
	session := c.rec.sess["test"]
	c.rec.mu.Unlock()
	if session == nil || session == old || session.reason != "schedule" {
		t.Fatal("source edit did not restart with original reason")
	}
	select {
	case <-old.done:
	default:
		t.Fatal("replacement started before old process exited")
	}
	args := strings.Join(session.cmd.Args, "|")
	if !strings.Contains(args, input) || !strings.Contains(args, "-segment_time|20") {
		t.Fatal("replacement uses stale source or segment duration")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		entries, _ := os.ReadDir(session.dir)
		for _, entry := range entries {
			if info, err := entry.Info(); err == nil && strings.HasSuffix(entry.Name(), ".ts") && info.Size() > 0 {
				return
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("replacement recording did not produce media")
}
