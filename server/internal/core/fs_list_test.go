package core

import "testing"

func TestListFSRoots(t *testing.T) {
	c := &Core{}
	entries, path, err := c.ListFS("", "dir")
	if err != nil {
		t.Fatal(err)
	}
	if path != "" {
		t.Fatalf("path=%q", path)
	}
	if len(entries) == 0 {
		t.Fatal("no roots")
	}
	t.Logf("roots=%d first=%+v", len(entries), entries[0])
	e2, p2, err := c.ListFS(entries[0].Path, "dir")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("drive %q cleaned=%q entries=%d", entries[0].Path, p2, len(e2))
	for i, e := range e2 {
		if i > 12 {
			break
		}
		t.Logf("  dir=%v name=%q path=%q", e.Dir, e.Name, e.Path)
	}
}
