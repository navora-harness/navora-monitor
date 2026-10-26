package core

import (
	"maps"
	"os"
)

type cachedMediaIndex struct {
	info    os.FileInfo
	entries map[string]indexEntry
}

// Caller holds indexMu. Clones keep failed writes from modifying the cache.
// Stat and file identity detect external changes and atomic replacements.
func (m *mediaKit) readIndex(path string) map[string]indexEntry {
	info, err := os.Stat(path)
	if err != nil {
		m.invalidateIndex(path)
		return map[string]indexEntry{}
	}
	if cached, ok := m.indexCache[path]; ok && cached.info.Size() == info.Size() && cached.info.ModTime().Equal(info.ModTime()) && os.SameFile(cached.info, info) {
		return maps.Clone(cached.entries)
	}
	m.invalidateIndex(path)
	entries := readIndex(path)
	if len(entries) <= 100_000 {
		if len(m.indexCache) >= 64 || m.indexRecords+len(entries) > 100_000 {
			m.indexCache = nil
			m.indexRecords = 0
		}
		if m.indexCache == nil {
			m.indexCache = map[string]cachedMediaIndex{}
		}
		m.indexCache[path] = cachedMediaIndex{info: info, entries: entries}
		m.indexRecords += len(entries)
	}
	return maps.Clone(entries)
}

func (m *mediaKit) invalidateIndex(path string) {
	if cached, ok := m.indexCache[path]; ok {
		m.indexRecords -= len(cached.entries)
		delete(m.indexCache, path)
	}
}

func (m *mediaKit) writeIndex(path string, entries map[string]indexEntry) error {
	m.invalidateIndex(path)
	return writeIndex(path, entries)
}

// Directory enumeration happens outside indexMu. Apply only entries whose
// snapshot still matches, preserving probes and concurrent directory queries.
func (m *mediaKit) mergeIndexChanges(path string, snapshot, updates map[string]indexEntry, removals []string) error {
	m.indexMu.Lock()
	defer m.indexMu.Unlock()
	current := m.readIndex(path)
	changed := false
	unchanged := func(name string) bool {
		before, existed := snapshot[name]
		now, exists := current[name]
		return existed == exists && before == now
	}
	for name, entry := range updates {
		if unchanged(name) && current[name] != entry {
			current[name] = entry
			changed = true
		}
	}
	for _, name := range removals {
		if _, exists := current[name]; exists && unchanged(name) {
			delete(current, name)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return m.writeIndex(path, current)
}
