package core

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func BenchmarkMediaIndex(b *testing.B) {
	path := filepath.Join(b.TempDir(), "index.json")
	entries := map[string]indexEntry{}
	for i := 0; i < 10_000; i++ {
		name := fmt.Sprintf("segment-%d.ts", i)
		entries[name] = indexEntry{FileName: name, StartMs: int64(i) * 300_000, DurationMs: 300_000}
	}
	if err := writeIndex(path, entries); err != nil {
		b.Fatal(err)
	}
	b.Run("uncached", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			readIndex(path)
		}
	})
	b.Run("cached", func(b *testing.B) {
		var media mediaKit
		media.readIndex(path)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			media.readIndex(path)
		}
	})
}

func TestIndexCacheTracksExternalChangesAndIsolatesWrites(t *testing.T) {
	var media mediaKit
	path := filepath.Join(t.TempDir(), "index.json")
	if err := writeIndex(path, map[string]indexEntry{"a": {FileName: "a", DurationMs: 1000}}); err != nil {
		t.Fatal(err)
	}
	first := media.readIndex(path)
	first["a"] = indexEntry{FileName: "a", DurationMs: 9999}
	if got := media.readIndex(path)["a"].DurationMs; got != 1000 {
		t.Fatal("uncommitted mutation leaked", got)
	}
	if err := writeIndex(path, map[string]indexEntry{"b": {FileName: "b", DurationMs: 2000}}); err != nil {
		t.Fatal(err)
	}
	if got := media.readIndex(path); len(got) != 1 || got["b"].DurationMs != 2000 {
		t.Fatal("external replacement ignored", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if got := media.readIndex(path); len(got) != 0 {
		t.Fatal("deleted index retained", got)
	}
}

func TestDirectoryScanMergePreservesConcurrentMetadata(t *testing.T) {
	var media mediaKit
	path := filepath.Join(t.TempDir(), "index.json")
	original := map[string]indexEntry{
		"measured": {FileName: "measured", DurationMs: 1000},
		"deleted":  {FileName: "deleted", DurationMs: 1000},
		"stale":    {FileName: "stale", DurationMs: 1000},
	}
	if err := writeIndex(path, original); err != nil {
		t.Fatal(err)
	}
	// A probe finishes while a directory scan is in progress.
	current := map[string]indexEntry{
		"measured": {FileName: "measured", DurationMs: 3000, Measured: true},
		"deleted":  original["deleted"],
		"stale":    {FileName: "stale", DurationMs: 4000, Measured: true},
		"added":    {FileName: "added", DurationMs: 5000},
	}
	if err := writeIndex(path, current); err != nil {
		t.Fatal(err)
	}
	updates := map[string]indexEntry{"measured": {FileName: "measured", DurationMs: 2000}, "new": {FileName: "new", DurationMs: 6000}}
	if err := media.mergeIndexChanges(path, original, updates, []string{"deleted", "stale"}); err != nil {
		t.Fatal(err)
	}
	got := readIndex(path)
	if got["measured"] != current["measured"] || got["stale"] != current["stale"] || got["added"] != current["added"] || got["new"] != updates["new"] {
		t.Fatal("concurrent updates lost", got)
	}
	if _, exists := got["deleted"]; exists {
		t.Fatal("unchanged stale entry retained")
	}
}
