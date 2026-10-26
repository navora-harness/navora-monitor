package core

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// A container's duration can include corrupt/discontinuous timestamps. Even a
// matching source version does not make such a value a valid wall-clock range.
func measuredBoundsPlausible(entry indexEntry, info os.FileInfo, now int64) bool {
	duration := entry.DurationMs
	if entry.StartMs <= 0 || duration <= 0 || duration > 7*24*60*60*1000 || !durationFitsSize(duration, info.Size()) {
		return false
	}
	end := entry.StartMs + duration
	if end > now+60_000 {
		return false
	}
	mtime := info.ModTime().UnixMilli()
	return mtime <= entry.StartMs || end <= mtime+60_000
}

// Backfill a small batch per pass so old archives cannot monopolize media work.
// Only completed files are probed, and results are bound to their source version.
func (c *Core) reconcileMediaMetadata() {
	recordings, saved := c.ListRecordings(""), c.ListSaved("")
	segments := make([]Segment, 0, len(recordings)+len(saved))
	for i := 0; i < len(recordings) || i < len(saved); i++ {
		if i < len(recordings) {
			segments = append(segments, recordings[i])
		}
		if i < len(saved) {
			segments = append(segments, saved[i])
		}
	}
	// A pass reads each channel index once, rather than once per file.
	snapshots := map[string]map[string]indexEntry{}
	budget := 2
	for _, segment := range segments {
		if budget == 0 {
			return
		}
		if segment.State != "ready" {
			continue
		}
		path := filepath.Join(c.recordingsRoot(), segment.ChannelID, "index.json")
		if segment.Protected {
			path = filepath.Join(c.savedRoot(), segment.ChannelID, "index.json")
		}
		retryKey := path + segment.SourceVersion + segment.ID
		if until := c.media.metadataRetry[retryKey]; time.Now().Before(until) {
			continue
		}
		indexSnapshot, loaded := snapshots[path]
		if !loaded {
			c.media.indexMu.Lock()
			indexSnapshot = c.media.readIndex(path)
			c.media.indexMu.Unlock()
			snapshots[path] = indexSnapshot
		}
		entry := indexSnapshot[segment.FileName]
		infoBefore, statBeforeErr := os.Stat(segment.Path)
		if entry.Measured && entry.SourceVersion == segment.SourceVersion && statBeforeErr == nil && measuredBoundsPlausible(entry, infoBefore, time.Now().UnixMilli()) {
			continue
		}
		budget--
		if c.media.metadataRetry == nil || len(c.media.metadataRetry) > 1024 {
			c.media.metadataRetry = map[string]time.Time{}
		}
		c.media.metadataRetry[retryKey] = time.Now().Add(time.Minute)
		ctx, cancelShutdown := c.mediaContext(context.Background())
		ctx, cancelTimeout := context.WithTimeout(ctx, 8*time.Second)
		release, err := c.media.leases.acquireContext(ctx, segment.Path)
		if err != nil {
			cancelTimeout()
			cancelShutdown()
			continue
		}
		var probe mediaProbe
		err = c.media.work.run(backgroundMediaContext(ctx, 2), func() error {
			var probeErr error
			probe, probeErr = c.probeMedia(ctx, segment.Path)
			return probeErr
		})
		cancelTimeout()
		cancelShutdown()
		info, statErr := os.Stat(segment.Path)
		release()
		if err != nil || statErr != nil {
			continue
		}
		version := strconv.FormatInt(info.Size(), 10) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
		if version != segment.SourceVersion || c.sourceWriting(segment.Path) {
			continue
		}
		seconds := videoDurationSeconds(probe)
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 || seconds > 7*24*60*60 {
			continue
		}
		duration := int64(seconds * 1000)
		candidate := indexEntry{FileName: segment.FileName, StartMs: deref(segment.StartMs),
			EndMs: deref(segment.StartMs) + duration, DurationMs: duration, SizeBytes: info.Size(), IndexedAt: time.Now().UnixMilli(),
			SourceVersion: version, Measured: true}
		if !measuredBoundsPlausible(candidate, info, time.Now().UnixMilli()) {
			continue
		}
		c.media.indexMu.Lock()
		index := c.media.readIndex(path)
		index[segment.FileName] = candidate
		c.media.writeIndex(path, index)
		c.media.indexMu.Unlock()
	}
}
