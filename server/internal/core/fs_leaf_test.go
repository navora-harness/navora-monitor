package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListFSLeafFiles(t *testing.T) {
	dir := filepath.Join(os.TempDir(), "navora-leaf-pick")
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
