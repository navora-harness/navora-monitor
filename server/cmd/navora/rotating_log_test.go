package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLogRotatesDuringContinuousWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "service.log")
	w, err := newRotatingLog(path, 256)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				if _, err := w.Write([]byte("concurrent service message\n")); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	if _, err := w.Write([]byte("last message\n")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, path + ".1"} {
		info, err := os.Stat(name)
		if err != nil || info.Size() > 256 {
			t.Fatalf("log grew beyond limit: %s %v", name, err)
		}
	}
	contents, err := os.ReadFile(path)
	if err != nil || !bytes.HasSuffix(contents, []byte("last message\n")) {
		t.Fatal("latest message missing")
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("after close")); err == nil {
		t.Fatal("write accepted after close")
	}
}

func TestOversizedLogMessageIsBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.log")
	w, err := newRotatingLog(path, 128)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	payload := bytes.Repeat([]byte("x"), 1024)
	if n, err := w.Write(payload); err != nil || n != len(payload) {
		t.Fatalf("write: %d %v", n, err)
	}
	contents, err := os.ReadFile(path)
	if err != nil || len(contents) != 128 {
		t.Fatal("oversized entry grew log beyond limit")
	}
}
