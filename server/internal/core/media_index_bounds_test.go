package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

type boundsFileInfo struct {
	os.FileInfo
	size     int64
	modified time.Time
}

func TestEmptyArchiveDoesNotHideCachedRecording(t *testing.T) {
	c := isolatedCore(t)
	c.settings.RecordCacheEnabled = true
	c.settings.RecordCachePath = filepath.Join(t.TempDir(), "cache")
	name := "test-20261013-060000.ts"
	archive := filepath.Join(c.channelRecordDir("test"), name)
	cache := filepath.Join(c.channelCacheDir("test"), name)
	for _, p := range []string{archive, cache} {
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(archive, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cache, make([]byte, 188*10), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := c.resolveMedia("recordings", "test", name)
	if err != nil || !samePath(got, cache) {
		t.Fatalf("resolved %s: %v", got, err)
	}
	list := c.ListRecordings("test")
	if len(list) != 1 || !samePath(list[0].Path, cache) {
		t.Fatalf("list disagrees with resolver: %+v", list)
	}
	if st, err := os.Stat(archive); err != nil || st.Size() != 0 {
		t.Fatal("original placeholder modified")
	}
}

func TestVideoDurationIgnoresCorruptAudioClock(t *testing.T) {
	var p mediaProbe
	if err := json.Unmarshal([]byte(`{"streams":[{"codec_type":"video","codec_name":"hevc","duration":"297.999800"},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"91308.088456"}}`), &p); err != nil {
		t.Fatal(err)
	}
	if videoDurationSeconds(p) != 297.9998 || !needsAudioClockRepair(p) {
		t.Fatal("audio clock still defines the timeline")
	}
	p.Format.Duration = "298.1"
	if needsAudioClockRepair(p) {
		t.Fatal("normal audio clock incorrectly repaired")
	}
}

func (i boundsFileInfo) Size() int64        { return i.size }
func (i boundsFileInfo) ModTime() time.Time { return i.modified }

func TestMeasuredBoundsRejectCorruptClockSpans(t *testing.T) {
	startTime := time.Date(2026, 10, 13, 6, 0, 0, 0, time.Local)
	start := startTime.UnixMilli()
	now := startTime.Add(3 * time.Hour).UnixMilli()
	info := boundsFileInfo{size: 2_000_000_000, modified: startTime.Add(5 * time.Minute)}
	version := strconv.FormatInt(info.Size(), 10) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	for _, duration := range []int64{3*3600_000 + 120_000, 16 * 3600_000, 25 * 3600_000} {
		entry := indexEntry{FileName: "cam-20261013-060000.ts", StartMs: start, EndMs: start + duration, DurationMs: duration, SizeBytes: info.Size(), SourceVersion: version, Measured: true}
		if measuredBoundsPlausible(entry, info, now) {
			t.Fatalf("accepted corrupt duration %d", duration)
		}
		a, b, update := segmentBounds(entry.FileName, info, entry, 300, now)
		if a != start || b > now || b-a > 600_000 || update == nil || update.Measured {
			t.Fatalf("bad index not replaced: %d %d %+v", a, b, update)
		}
	}
	// The duration fits the current clock, but exceeds when this file closed.
	entry := indexEntry{StartMs: start, DurationMs: 2 * 3600_000}
	if measuredBoundsPlausible(entry, info, now) {
		t.Fatal("accepted duration past file close")
	}
	info.modified = startTime.Add(2 * time.Hour)
	if !measuredBoundsPlausible(entry, info, now) {
		t.Fatal("rejected an actual long recording")
	}
}
