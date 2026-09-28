package core

import (
	"net/url"
	"path/filepath"
	"testing"
)

func TestListFSQueryPath(t *testing.T) {
	v, err := url.ParseQuery("path=C%3A%5C&mode=dir")
	if err != nil {
		t.Fatal(err)
	}
	p := v.Get("path")
	t.Logf("decoded=%q clean=%q", p, filepath.Clean(p))
	c := &Core{}
	entries, path, err := c.ListFS(p, "dir")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("path=%q n=%d", path, len(entries))
	if len(entries) == 0 {
		t.Fatal("empty")
	}
}
