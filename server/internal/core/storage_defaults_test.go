package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestStorageDefaultsPinnedToDataRoot(t *testing.T) {
	root := t.TempDir()
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, "media", "recordings")
	if c.recordingsRoot() != want {
		t.Fatalf("default changed with account: %s", c.recordingsRoot())
	}
	var saved Settings
	data, err := os.ReadFile(filepath.Join(root, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &saved); err != nil || saved.RecordingsPath != want {
		t.Fatal("default not pinned", err)
	}
	if _, err := Open(root); err != nil {
		t.Fatal(err)
	}
}

func TestMissingSettingsWithExistingDataFailsWithoutCreatingFile(t *testing.T) {
	for _, name := range []string{"auth.json", "channels.json"} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, name), []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(root); err == nil || !strings.Contains(err.Error(), "settings.json") {
			t.Fatal("missing legacy settings accepted", err)
		}
		if _, err := os.Stat(filepath.Join(root, "settings.json")); !os.IsNotExist(err) {
			t.Fatal("created replacement settings")
		}
	}
}

func TestLegacyContentPinnedWithoutMoving(t *testing.T) {
	home := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	old := filepath.Join(home, "Videos", "Navora Monitor", "recordings")
	if err := os.MkdirAll(old, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(old, "original.ts")
	if err := os.WriteFile(file, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if c.recordingsRoot() != old {
		t.Fatal("legacy content hidden")
	}
	if data, _ := os.ReadFile(file); string(data) != "unchanged" {
		t.Fatal("legacy source changed")
	}
	// Explicit reset chooses the new stable default rather than rediscovering old storage.
	next := c.Settings()
	next.RecordingsPath = ""
	if _, err := c.UpdateSettings(next); err != nil {
		t.Fatal(err)
	}
	if c.recordingsRoot() != filepath.Join(root, "media", "recordings") {
		t.Fatal("reset did not use data root")
	}
}

func TestRemoteSwitchFailureDoesNotPersist(t *testing.T) {
	c := isolatedCore(t)
	c.SetRemoteSwitch(func(bool) error { return os.ErrPermission })
	next := c.Settings()
	next.RemoteEnabled = true
	if _, err := c.UpdateSettings(next); err == nil {
		t.Fatal("switch failure ignored")
	}
	if c.Settings().RemoteEnabled {
		t.Fatal("failed change persisted")
	}
}

func TestUpgradePreservesExplicitStorageAndCacheSettings(t *testing.T) {
	root := t.TempDir()
	want := defaultSettings()
	want.RecordingsPath = filepath.Join(root, "archive")
	want.SavedClipsPath = filepath.Join(root, "protected")
	want.SnapshotsPath = filepath.Join(root, "pictures")
	want.RecordCachePath = filepath.Join(root, "fast-cache")
	want.RecordCacheEnabled = false
	want.RetentionDays = 17
	want.RemoteEnabled = true
	want.RemotePort = 8899
	data, _ := json.Marshal(want)
	if err := os.WriteFile(filepath.Join(root, "settings.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Settings(); got != want {
		t.Fatalf("legacy settings changed: %+v", got)
	}
	after, _ := os.ReadFile(filepath.Join(root, "settings.json"))
	if string(after) != string(data) {
		t.Fatal("explicit legacy config rewritten")
	}
}

func TestSettingsWriteFailureRestoresRemoteSwitch(t *testing.T) {
	c := isolatedCore(t)
	var switches []bool
	c.SetRemoteSwitch(func(enabled bool) error { switches = append(switches, enabled); return nil })
	path := filepath.Join(c.root, "settings.json")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	next := c.Settings()
	next.RemoteEnabled = true
	if _, err := c.UpdateSettings(next); err == nil {
		t.Fatal("failed write accepted")
	}
	if c.Settings().RemoteEnabled || len(switches) != 2 || !switches[0] || switches[1] {
		t.Fatal("listener not rolled back", switches)
	}
}

func TestNewStorageCannotUseWindowsDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows paths")
	}
	c := isolatedCore(t)
	next := c.Settings()
	next.RecordingsPath = filepath.Join(os.Getenv("SystemRoot"), "NavoraTest")
	if _, err := c.UpdateSettings(next); err == nil {
		t.Fatal("system directory accepted")
	}
}

func TestRelativeStoragePathsResolveAgainstDataRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte(`{"recordingsPath":"archive","savedClipsPath":"clips","snapshotsPath":"pictures","recordCachePath":"cache","recordCacheEnabled":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	s := c.Settings()
	if s.RecordingsPath != filepath.Join(root, "archive") || s.RecordCachePath != filepath.Join(root, "cache") || s.RecordCacheEnabled {
		t.Fatal("relative paths depend on process working directory", s)
	}
}
