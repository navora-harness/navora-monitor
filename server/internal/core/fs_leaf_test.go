package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListFSLeafFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "only-file.txt"), []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, path, err := (&Core{}).ListFS(dir, "dir")
	if err != nil {
		t.Fatal(err)
	}
	if path == "" {
		t.Fatal("empty path")
	}
	if len(entries) == 0 {
		t.Fatal("expected files visible in dir mode")
	}
	found := false
	for _, e := range entries {
		if e.Name == "only-file.txt" && !e.Dir {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing only-file.txt: %+v", entries)
	}
}
