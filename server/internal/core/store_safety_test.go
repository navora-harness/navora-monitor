package core

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestCorruptConfigPreventsStartupAndPreservesOriginal(t *testing.T) {
	for _, name := range []string{"settings.json", "channels.json", "auth.json"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			if name != "settings.json" {
				if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte(`{}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			path := filepath.Join(root, name)
			original := []byte(`{"version":`)
			if err := os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(root); err == nil || !strings.Contains(err.Error(), name) {
				t.Fatalf("corrupt configuration silently accepted: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(after, original) {
				t.Fatal("corrupt original overwritten")
			}
		})
	}
}

func TestConcurrentConfigWritesPublishWholeFiles(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := writeFileAtomic(path, bytes.Repeat([]byte{byte('a' + i)}, 65536)); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(contents) != 65536 || !bytes.Equal(contents, bytes.Repeat(contents[:1], 65536)) {
		t.Fatal("partial or mixed file published")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatal("temporary config files leaked")
	}
}

func TestReopeningPreservesPassword(t *testing.T) {
	root := t.TempDir()
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	password, created, _, err := c.EnsurePassword(false)
	if err != nil || !created {
		t.Fatalf("initialization: %v", err)
	}
	c, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, created, _, err := c.EnsurePassword(false); err != nil || created {
		t.Fatalf("password replaced on reopen: %v", err)
	}
	if !c.CheckLogin(c.Settings().RemoteUsername, password) {
		t.Fatal("stored password not accepted")
	}
}
