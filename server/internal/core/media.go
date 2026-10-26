package core

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type mediaKit struct {
	work          mediaScheduler
	diskCompute   sync.Mutex
	rateAt        time.Time
	rateSizes     map[string]int64
	rateValue     float64
	jobsMu        sync.Mutex
	jobs          map[string]*playbackJob
	c             *Core
	sem           chan struct{}
	exportSem     chan struct{}
	exportSlots   chan struct{}
	leases        fileLeases
	indexMu       sync.Mutex
	indexCache    map[string]cachedMediaIndex
	indexRecords  int
	metadataRetry map[string]time.Time
	mu            sync.Mutex
	disk          diskSnap
	lastAction    map[string]any
}

type diskSnap struct {
	at   time.Time
	info DiskInfo
}

type DiskInfo struct {
	CacheFreeBytes     *uint64  `json:"cacheFreeBytes,omitempty"`
	CacheLevel         string   `json:"cacheLevel,omitempty"`
	Path               string   `json:"path"`
	FreeBytes          uint64   `json:"freeBytes"`
	TotalBytes         uint64   `json:"totalBytes"`
	FreeRatio          float64  `json:"freeRatio"`
	RecordingsBytes    uint64   `json:"recordingsBytes"`
	SavedClipsBytes    uint64   `json:"savedClipsBytes"`
	WriteBytesPerSec   float64  `json:"writeBytesPerSec"`
	EstimatedRemainSec *float64 `json:"estimatedRemainSec"`
	RetentionNeedBytes *float64 `json:"retentionNeedBytes"`
	RetentionDays      int      `json:"retentionDays"`
	RetentionFit       bool     `json:"retentionFit"`
	Level              string   `json:"level"`
	RecordingBlocked   bool     `json:"recordingBlocked"`
	Warn               bool     `json:"warn"`
	Stop               bool     `json:"stop"`
	AutoCleanup        bool     `json:"autoCleanup"`
	LastAction         any      `json:"lastAction"`
}

func newMedia(c *Core) *mediaKit {
	return &mediaKit{c: c, sem: make(chan struct{}, 1), exportSem: make(chan struct{}, 1), exportSlots: make(chan struct{}, 4)}
}

func (m *mediaKit) withExclusive(fn func()) {
	m.sem <- struct{}{}
	defer func() { <-m.sem }()
	fn()
}

func (c *Core) Disk() DiskInfo {
	c.media.diskCompute.Lock()
	defer c.media.diskCompute.Unlock()
	c.media.mu.Lock()
	if time.Since(c.media.disk.at) < 8*time.Second {
		info := c.media.disk.info
		c.media.mu.Unlock()
		return info
	}
	c.media.mu.Unlock()
	info := c.computeDisk()
	c.media.mu.Lock()
	info.LastAction = c.media.lastAction
	c.media.disk = diskSnap{at: time.Now(), info: info}
	c.media.mu.Unlock()
	return info
}

func (c *Core) computeDisk() DiskInfo {
	root := c.recordingsRoot()
	free, total, derr := diskUsage(root)
	s := c.Settings()
	recBytes := dirSize(root)
	savedBytes := dirSize(c.savedRoot())
	level := "ok"
	if derr == nil && total > 0 {
		level = evaluateStorageLevel(free, s.DiskWarnFreeGb, s.DiskStopFreeGb)
	}
	var cacheFree *uint64
	cacheLevel := ""
	limitingFree := free
	if cache := c.cacheRoot(); cache != "" {
		available, _, cacheErr := diskUsage(cache)
		if cacheErr == nil {
			cacheFree = &available
			cacheLevel = evaluateStorageLevel(available, s.DiskWarnFreeGb, s.DiskStopFreeGb)
			if available < limitingFree {
				limitingFree = available
			}
			if cacheLevel == "critical" || cacheLevel == "warn" && level == "ok" {
				level = cacheLevel
			}
		} else {
			cacheLevel = "critical"
			level = "critical"
		}
	}
	rate := c.writeRate()
	var remain *float64
	if rate > 0 && free > 0 {
		v := float64(limitingFree) / rate
		remain = &v
	}
	var need *float64
	fit := true
	if s.RetentionDays > 0 {
		var v float64
		if rate > 0 {
			v = rate * float64(s.RetentionDays) * 86400
		}
		// Short-window write rate underestimates when cameras idle or when
		// already-retained footage is denser than the last few minutes.
		// Floor against bytes currently on disk so capacity perception matches reality.
		if float64(recBytes) > v {
			v = float64(recBytes)
		}
		if v > 0 {
			need = &v
			if v > float64(free) {
				fit = false
				if level == "ok" {
					level = "warn"
				}
			}
		}
	}
	ratio := 0.0
	if total > 0 {
		ratio = float64(free) / float64(total)
	}
	return DiskInfo{
		CacheFreeBytes: cacheFree, CacheLevel: cacheLevel,
		Path:               root,
		FreeBytes:          free,
		TotalBytes:         total,
		FreeRatio:          ratio,
		RecordingsBytes:    recBytes,
		SavedClipsBytes:    savedBytes,
		WriteBytesPerSec:   rate,
		EstimatedRemainSec: remain,
		RetentionNeedBytes: need,
		RetentionDays:      s.RetentionDays,
		RetentionFit:       fit,
		Level:              level,
		RecordingBlocked:   level == "critical",
		Warn:               level == "warn" || level == "critical",
		Stop:               level == "critical",
		AutoCleanup:        s.DiskAutoCleanup,
	}
}

func (c *Core) writeRate() float64 {
	c.rec.mu.Lock()
	dirs := map[string]string{}
	for id, session := range c.rec.sess {
		dirs[id] = session.dir
	}
	c.rec.mu.Unlock()
	sizes := map[string]int64{}
	modified := map[string]time.Time{}
	for id, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		// Names include a sortable wall-clock suffix. Keep a few recent files;
		// historical storage size must never be counted as newly-written bytes.
		count := 0
		for i := len(entries) - 1; i >= 0 && count < 4; i-- {
			entry := entries[i]
			if entry.IsDir() || !isRecordingMediaFile(entry.Name()) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			sizes[id+"/"+entry.Name()] = info.Size()
			modified[id+"/"+entry.Name()] = info.ModTime()
			count++
		}
	}
	now := time.Now()
	c.media.mu.Lock()
	defer c.media.mu.Unlock()
	var delta int64
	if !c.media.rateAt.IsZero() {
		for key, size := range sizes {
			old, known := c.media.rateSizes[key]
			if !known && modified[key].Before(c.media.rateAt) {
				continue
			}
			if size > old {
				delta += size - old
			}
		}
		seconds := now.Sub(c.media.rateAt).Seconds()
		if seconds > 0 {
			c.media.rateValue = float64(delta) / seconds
		}
	}
	if len(dirs) == 0 {
		c.media.rateValue = 0
	}
	c.media.rateSizes = sizes
	c.media.rateAt = now
	return c.media.rateValue
}

func dirSize(root string) uint64 {
	var n uint64
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if isRecordingMediaFile(info.Name()) || strings.HasSuffix(strings.ToLower(info.Name()), ".png") || strings.HasSuffix(strings.ToLower(info.Name()), ".jpg") {
			n += uint64(info.Size())
		}
		return nil
	})
	return n
}

func (c *Core) maybeCleanup() {
	s := c.Settings()
	if !s.DiskAutoCleanup && s.RetentionDays <= 0 {
		return
	}
	info := c.Disk()
	if s.DiskAutoCleanup && (info.Level == "warn" || info.Level == "critical") {
		c.cleanupUntil(cleanupTargetFreeBytes(s.DiskWarnFreeGb, s.DiskStopFreeGb))
	}
	if s.RetentionDays > 0 {
		c.cleanupOlderThanDays(s.RetentionDays)
	}
}

func (c *Core) cleanupUntil(target int64) {
	if target <= 0 {
		return
	}
	files := c.loopFiles()
	var deleted int
	var freed uint64
	nowMs := time.Now().UnixMilli()
	for _, f := range files {
		free, _, err := diskUsage(c.recordingsRoot())
		if err != nil || int64(free) >= target {
			break
		}
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		if c.sourceWriting(f) || isSegmentWriting(st.ModTime().UnixMilli(), nowMs) {
			continue
		}
		if c.removeMedia(f) == nil {
			deleted++
			freed += uint64(st.Size())
		}
	}
	if deleted > 0 {
		c.noteAction(map[string]any{
			"type": "cleanup", "message": "已自动清理最早的循环录像", "deleted": deleted, "freedBytes": freed, "at": time.Now().UnixMilli(),
		})
	}
}

func (c *Core) cleanupOlderThanDays(days int) {
	cut := retentionCutoffLocal(days, time.Now())
	if cut.IsZero() {
		return
	}
	var deleted int
	var freed uint64
	nowMs := time.Now().UnixMilli()
	for _, f := range c.loopFiles() {
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		if c.sourceWriting(f) || isSegmentWriting(st.ModTime().UnixMilli(), nowMs) {
			continue
		}
		// Match timeline perception: age by filename stamp (content start),
		// not mtime — long segments and remux can keep mtime "fresh".
		if !recordingContentTime(f, st.ModTime()).Before(cut) {
			continue
		}
		if c.removeMedia(f) == nil {
			deleted++
			freed += uint64(st.Size())
		}
	}
	if deleted > 0 {
		c.noteAction(map[string]any{
			"type": "cleanup", "message": "已按保留天数清理循环录像", "deleted": deleted, "freedBytes": freed, "at": time.Now().UnixMilli(),
		})
	}
}

func (c *Core) noteAction(a map[string]any) {
	c.media.mu.Lock()
	c.media.lastAction = a
	c.media.disk.at = time.Time{}
	c.media.mu.Unlock()
	c.events.Publish("storageAction", a)
	c.events.Publish("storage", c.Disk())
}

func (c *Core) loopFiles() []string {
	type candidate struct {
		path string
		mod  time.Time
	}
	var items []candidate
	_ = filepath.Walk(c.recordingsRoot(), func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() && isRecordingMediaFile(info.Name()) {
			items = append(items, candidate{path, info.ModTime()})
		}
		return nil
	})
	sort.Slice(items, func(i, j int) bool { return items[i].mod.Before(items[j].mod) })
	files := make([]string, len(items))
	for i, item := range items {
		files[i] = item.path
	}
	return files
}

func olderFile(a, b string) bool {
	sa, ea := os.Stat(a)
	sb, eb := os.Stat(b)
	if ea != nil || eb != nil {
		return a < b
	}
	return sa.ModTime().Before(sb.ModTime())
}

func (c *Core) ClearLoop() DiskInfo {
	c.rec.stopAll()
	for _, f := range c.loopFiles() {
		_ = c.removeMedia(f)
	}
	c.noteAction(map[string]any{"type": "cleanup", "message": "已清空循环录像", "at": time.Now().UnixMilli()})
	return c.Disk()
}

func (c *Core) RunCleanup() DiskInfo {
	s := c.Settings()
	c.cleanupUntil(cleanupTargetFreeBytes(s.DiskWarnFreeGb, s.DiskStopFreeGb))
	if s.RetentionDays > 0 {
		c.cleanupOlderThanDays(s.RetentionDays)
	}
	return c.Disk()
}

type Segment struct {
	ID            string  `json:"id"`
	ChannelID     string  `json:"channelId"`
	FileName      string  `json:"fileName"`
	Path          string  `json:"path"`
	URL           string  `json:"url"`
	PlaybackURL   *string `json:"playbackUrl"`
	SizeBytes     int64   `json:"sizeBytes"`
	MtimeMs       int64   `json:"mtimeMs"`
	StartMs       *int64  `json:"startMs"`
	EndMs         *int64  `json:"endMs"`
	State         string  `json:"state,omitempty"`
	SourceVersion string  `json:"sourceVersion,omitempty"`
	TimeMeasured  bool    `json:"timeMeasured"`
	Protected     bool    `json:"protected,omitempty"`
	SavedAt       *int64  `json:"savedAt,omitempty"`
}

func (c *Core) ListRecordings(channelID string) []Segment {
	return c.listKind("recordings", channelID, false)
}

func (c *Core) ListSaved(channelID string) []Segment {
	return c.listKind("saved", channelID, true)
}

func (c *Core) listKind(kind, channelID string, protected bool) []Segment {
	channels := c.Channels()
	var ids []string
	if channelID != "" {
		ids = []string{channelID}
	} else {
		for _, ch := range channels {
			ids = append(ids, ch.ID)
		}
	}
	defaultSegSec := c.Settings().DefaultSegmentTimeSec
	segSec := defaultSegSec
	if segSec < 10 {
		segSec = 300
	}
	out := []Segment{}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		segSec = defaultSegSec
		for _, ch := range channels {
			if ch.ID == id && ch.SegmentTimeSec >= 10 {
				segSec = ch.SegmentTimeSec
				break
			}
		}
		if !safeChannelID(id) {
			continue
		}
		if segSec < 10 {
			segSec = 300
		}
		activePath := c.activeRecordingPath(id)
		var dirs []string
		indexPath := ""
		if kind == "saved" {
			dirs = []string{filepath.Join(c.savedRoot(), id)}
			indexPath = filepath.Join(c.savedRoot(), id, "index.json")
		} else {
			rec := filepath.Join(c.recordingsRoot(), id)
			dirs = []string{rec}
			indexPath = filepath.Join(rec, "index.json")
			if cache := c.cacheRoot(); cache != "" {
				dirs = append(dirs, filepath.Join(cache, id))
			}
		}
		c.media.indexMu.Lock()
		index := c.media.readIndex(indexPath)
		c.media.indexMu.Unlock()
		updates := map[string]indexEntry{}
		var removals []string
		seen := map[string]bool{}
		var channelSegs []Segment
		dirty := false
		recording := !protected && c.rec != nil && c.rec.running(id)
		for _, dir := range dirs {
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				name := e.Name()
				if e.IsDir() || !isRecordingMediaFile(name) || seen[name] {
					continue
				}
				info, err := e.Info()
				if err != nil {
					continue
				}
				// A segment file is created empty and may stay under a flush
				// for a while. Keep a recently touched file so the live bar can draw.
				mtime := info.ModTime().UnixMilli()
				if info.Size() < 64 && !samePath(filepath.Join(dir, name), activePath) {
					if preferred, resolveErr := c.resolveMedia(kind, id, name); resolveErr == nil && !samePath(preferred, filepath.Join(dir, name)) {
						continue
					}
				}
				if info.Size() < 64 && now-mtime > 180_000 {
					continue
				}
				seen[name] = true
				start, end, updated := segmentBounds(name, info, index[name], segSec, now)
				state := "ready"
				if activePath != "" && samePath(filepath.Join(dir, name), activePath) {
					state = "writing"
				}
				if info.Size() < 64 && state != "writing" {
					state = "invalid"
				}
				measured := index[name].Measured
				if updated != nil {
					updates[name] = *updated
					measured = updated.Measured
					dirty = true
				}
				fileURL := "/media/files/" + kind + "/" + id + "/" + name
				pb := fileURL
				seg := Segment{
					State:         state,
					SourceVersion: strconv.FormatInt(info.Size(), 10) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 10),
					TimeMeasured:  measured,
					ID:            id + "/" + name,
					ChannelID:     id,
					FileName:      name,
					Path:          filepath.Join(dir, name),
					URL:           fileURL,
					PlaybackURL:   &pb,
					SizeBytes:     info.Size(),
					MtimeMs:       mtime,
					StartMs:       i64ptr(start),
					EndMs:         i64ptr(end),
					Protected:     protected,
				}
				if protected {
					seg.SavedAt = i64ptr(mtime)
				}
				channelSegs = append(channelSegs, seg)
			}
		}
		if !protected {
			channelSegs = trimSegmentEnds(channelSegs)
			if recording {
				extendOpenSegment(channelSegs, now)
			}
			alive := map[string]bool{}
			for _, s := range channelSegs {
				alive[s.FileName] = true
			}
			for name := range index {
				if !alive[name] {
					removals = append(removals, name)
					dirty = true
				}
			}
		}
		if protected {
			alive := map[string]bool{}
			for _, s := range channelSegs {
				alive[s.FileName] = true
			}
			for name := range index {
				if !alive[name] {
					removals = append(removals, name)
					dirty = true
				}
			}
		}
		if dirty && indexPath != "" {
			c.media.mergeIndexChanges(indexPath, index, updates, removals)
		}
		out = append(out, channelSegs...)
	}
	sort.Slice(out, func(i, j int) bool {
		return deref(out[i].StartMs) > deref(out[j].StartMs)
	})
	return out
}

func i64ptr(v int64) *int64 { return &v }

func deref(v *int64) int64 {
	if v == nil {
		return 0
	}
	return *v
}

func extendOpenSegment(segs []Segment, now int64) {
	var latest *Segment
	for i := range segs {
		if segs[i].State != "writing" {
			continue
		}
		start := deref(segs[i].StartMs)
		if start > now || now-start > 20*60_000 {
			continue
		}
		if latest == nil || start > deref(latest.StartMs) {
			latest = &segs[i]
		}
	}
	if latest != nil && deref(latest.EndMs) < now {
		latest.EndMs = i64ptr(now)
	}
}

type indexEntry struct {
	SourceVersion string `json:"sourceVersion,omitempty"`
	Measured      bool   `json:"measured,omitempty"`
	FileName      string `json:"fileName"`
	StartMs       int64  `json:"startMs"`
	EndMs         int64  `json:"endMs"`
	DurationMs    int64  `json:"durationMs"`
	SizeBytes     int64  `json:"sizeBytes"`
	IndexedAt     int64  `json:"indexedAt"`
}

func readIndex(path string) map[string]indexEntry {
	out := map[string]indexEntry{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var doc struct {
		Segments []indexEntry `json:"segments"`
	}
	if json.Unmarshal(b, &doc) != nil {
		return out
	}
	for _, s := range doc.Segments {
		out[s.FileName] = s
	}
	return out
}

func segmentBounds(name string, info os.FileInfo, idx indexEntry, segSec int, now int64) (int64, int64, *indexEntry) {
	size := info.Size()
	mtime := info.ModTime().UnixMilli()
	version := strconv.FormatInt(size, 10) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	if idx.Measured && !measuredBoundsPlausible(idx, info, now) {
		idx = indexEntry{}
	}
	if idx.Measured && idx.SourceVersion == version && idx.DurationMs > 0 {
		return idx.StartMs, idx.StartMs + idx.DurationMs, nil
	}
	if idx.SourceVersion != "" && idx.SourceVersion != version {
		idx = indexEntry{}
	}
	if idx.FileName != "" && cachedRangePlausible(idx.StartMs, idx.EndMs, idx.SizeBytes, size, segSec) {
		return idx.StartMs, idx.EndMs, nil
	}
	growing := idx.FileName != "" && size > idx.SizeBytes && idx.StartMs > 0 && now-mtime < 120_000
	if growing {
		end := idx.EndMs
		if mtime > end {
			end = mtime
		}
		if end < idx.StartMs+500 {
			end = idx.StartMs + 500
		}
		entry := indexEntry{
			FileName: name, StartMs: idx.StartMs, EndMs: end,
			DurationMs: end - idx.StartMs, SizeBytes: size, IndexedAt: now,
		}
		return idx.StartMs, end, &entry
	}
	var parsed *int64
	if start, ok := parseSegmentStartMs(name); ok {
		parsed = &start
	}
	var probed *int64
	if idx.FileName != "" && idx.SizeBytes == size && idx.DurationMs > 0 {
		probed = &idx.DurationMs
	}
	start, end := estimateSegmentBounds(parsed, mtime, probed, segSec, size, now)
	entry := indexEntry{
		FileName: name, StartMs: start, EndMs: end,
		DurationMs: end - start, SizeBytes: size, IndexedAt: now, SourceVersion: version,
	}
	return start, end, &entry
}

func trimSegmentEnds(segs []Segment) []Segment {
	if len(segs) < 2 {
		return segs
	}
	sort.Slice(segs, func(i, j int) bool {
		return deref(segs[i].StartMs) < deref(segs[j].StartMs)
	})
	for i := 0; i < len(segs)-1; i++ {
		curStart := deref(segs[i].StartMs)
		curEnd := deref(segs[i].EndMs)
		nextStart := deref(segs[i+1].StartMs)
		if curEnd > nextStart && nextStart > curStart {
			// Another file that starts a few seconds later is an overlapping
			// recording, not this file's end. Cutting here hides the whole segment.
			if nextStart-curStart < 60_000 && curEnd-curStart > (nextStart-curStart)*2 {
				continue
			}
			segs[i].EndMs = i64ptr(nextStart)
		}
	}
	return segs
}

func writeIndex(path string, index map[string]indexEntry) (err error) {
	defer func() {
		if err != nil {
			log.Printf("media index update failed: %v", err)
		}
	}()
	segs := make([]indexEntry, 0, len(index))
	for _, s := range index {
		segs = append(segs, s)
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].StartMs < segs[j].StartMs })
	doc := struct {
		Version  int          `json:"version"`
		Segments []indexEntry `json:"segments"`
	}{Version: 2, Segments: segs}
	b, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".navora-index-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(b); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func (c *Core) resolveMedia(kind, id, name string) (string, error) {
	if !safeChannelID(id) || strings.Contains(name, "/") || strings.Contains(name, "\\") || strings.Contains(name, "..") {
		return "", errStr("路径无效")
	}
	if !isRecordingMediaFile(name) {
		return "", errStr("不是录像文件")
	}
	var dirs []string
	switch kind {
	case "saved":
		dirs = []string{filepath.Join(c.savedRoot(), id)}
	case "recordings":
		dirs = []string{filepath.Join(c.recordingsRoot(), id)}
		if cache := c.cacheRoot(); cache != "" {
			dirs = append(dirs, filepath.Join(cache, id))
		}
	default:
		return "", errStr("路径无效")
	}
	var last error
	var emptyCandidate string
	for _, dir := range dirs {
		p := filepath.Join(dir, name)
		st, err := os.Stat(p)
		if err == nil && !st.IsDir() {
			if st.Size() < 64 {
				if emptyCandidate == "" {
					emptyCandidate = p
				}
				continue
			}
			return p, nil
		}
		if err != nil {
			last = err
		}
	}
	if emptyCandidate != "" {
		return emptyCandidate, nil
	}
	if last == nil {
		last = os.ErrNotExist
	}
	return "", last
}

func (c *Core) EnsurePlayable(kind, id, name string) (string, error) {
	return c.EnsurePlayableContext(context.Background(), kind, id, name)
}

func (c *Core) EnsurePlayableContext(parent context.Context, kind, id, name string) (string, error) {
	return c.prepareShared(parent, kind, id, name)
}

func (c *Core) ensurePlayableContext(parent context.Context, kind, id, name string) (string, error) {
	h264, _ := parent.Value(playbackH264Key{}).(bool)
	ctx, cancel := c.mediaContext(parent)
	defer cancel()
	src, err := c.resolveMedia(kind, id, name)
	if err != nil {
		return "", err
	}
	release, err := c.media.leases.acquireContext(ctx, src)
	if err != nil {
		return "", err
	}
	defer release()
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	if c.sourceWriting(src) {
		return "", errStr("该片段仍在写入，请稍后重试")
	}
	if strings.HasSuffix(strings.ToLower(name), ".mp4") && !h264 {
		return src, nil
	}
	sum := sha1.Sum([]byte(src))
	key := hex.EncodeToString(sum[:8]) + "-" + strconv.FormatInt(st.Size(), 10) + "-" + strconv.FormatInt(st.ModTime().UnixNano(), 10) + "-v2.mp4"
	if h264 {
		key = strings.TrimSuffix(key, ".mp4") + "-h264.mp4"
	}
	dst := filepath.Join(c.playCacheDir(), key)
	if cached, err := os.Stat(dst); err == nil && cached.Size() > 64 {
		_ = os.Chtimes(dst, time.Now(), time.Now())
		return dst, nil
	}
	err = c.media.work.run(ctx, func() error {
		if cached, err := os.Stat(dst); err == nil && cached.Size() > 64 {
			return nil
		}
		bin := c.ffmpegPath()
		if bin == "" {
			return errStr("未找到 FFmpeg")
		}
		probe, err := c.probeMedia(ctx, src)
		if err != nil {
			return errStr("录像校验失败：" + err.Error())
		}
		transcode := false
		for _, stream := range probe.Streams {
			if stream.CodecType == "video" {
				transcode = h264 && stream.CodecName != "h264"
				break
			}
		}
		if !transcode && strings.HasSuffix(strings.ToLower(name), ".mp4") {
			dst = src
			return nil
		}
		tmpFile, err := os.CreateTemp(c.playCacheDir(), ".prepare-*.mp4")
		if err != nil {
			return err
		}
		tmp := tmpFile.Name()
		if err = tmpFile.Close(); err != nil {
			os.Remove(tmp)
			return err
		}
		defer os.Remove(tmp)
		stderr := tailBuf(2048)
		args := playbackRemuxArgs(src, tmp, probe)
		if transcode {
			for i := 0; i+1 < len(args); {
				if args[i] == "-c:v" || args[i] == "-tag:v" || args[i] == "-bsf:v" {
					args = append(args[:i], args[i+2:]...)
				} else {
					i++
				}
			}
			options := []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", "scale=w='min(1920,iw)':h=-2,setpts=PTS-STARTPTS", "-fps_mode", "passthrough", "-threads", "2", "-tag:v", "avc1"}
			args = append(args[:len(args)-1], append(options, tmp)...)
		}
		cmd := exec.CommandContext(ctx, bin, args...)
		hideWindow(cmd)
		cmd.Stderr = stderr
		if err = cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errStr("准备回放失败：" + redactSecrets(stderr.String()))
		}
		if _, err = c.probeMedia(ctx, tmp); err != nil {
			return errStr("播放副本校验失败：" + err.Error())
		}
		after, err := os.Stat(src)
		if err != nil || after.Size() != st.Size() || !after.ModTime().Equal(st.ModTime()) {
			return errStr("录像发生变化，请重新加载")
		}
		return os.Rename(tmp, dst)
	})
	if err != nil {
		return "", err
	}
	releaseCache, err := c.media.leases.acquireContext(ctx, dst)
	if err != nil {
		return "", err
	}
	defer releaseCache()
	c.trimPlayCache()
	return dst, nil
}

func (c *Core) trimPlayCache() {
	dir := c.playCacheDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		mod  time.Time
	}
	var files []item
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || !strings.HasSuffix(e.Name(), ".mp4") {
			continue
		}
		total += info.Size()
		files = append(files, item{filepath.Join(dir, e.Name()), info.Size(), info.ModTime()})
	}
	const capBytes = 2 << 30
	if total <= capBytes {
		return
	}
	for i := 1; i < len(files); i++ {
		j := i
		for j > 0 && files[j].mod.Before(files[j-1].mod) {
			files[j], files[j-1] = files[j-1], files[j]
			j--
		}
	}
	for _, f := range files {
		if time.Since(f.mod) < 5*time.Minute {
			continue
		}
		if total <= capBytes {
			break
		}
		if c.removeMedia(f.path) == nil {
			total -= f.size
		}
	}
}

func (c *Core) firstPTS(path, stream string) (float64, bool) {
	probe := c.ffprobePath()
	if probe == "" {
		return 0, false
	}
	cmd := exec.Command(probe,
		"-v", "error",
		"-select_streams", stream,
		"-read_intervals", "%+#1",
		"-show_entries", "packet=pts_time",
		"-of", "csv=p=0",
		path,
	)
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return 0, false
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	line = strings.TrimRight(line, ",")
	n, err := strconv.ParseFloat(line, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func (c *Core) tsNeedsRepair(path string) bool {
	if c.ffprobePath() == "" {
		return true
	}
	v, ok := c.firstPTS(path, "v:0")
	if !ok {
		return false
	}
	a, okA := c.firstPTS(path, "a:0")
	if !okA {
		return v >= videoOrphanStartSec
	}
	if a-v < 0 {
		return v-a >= skewSec
	}
	return a-v >= skewSec
}

// Repair produces a separate playable copy. Never replace an original recording.
func (c *Core) normalizeTS(path string) bool {
	if !strings.HasSuffix(strings.ToLower(path), ".ts") {
		return false
	}
	id := filepath.Base(filepath.Dir(path))
	for _, kind := range []string{"recordings", "saved"} {
		resolved, err := c.resolveMedia(kind, id, filepath.Base(path))
		if err == nil && samePath(resolved, path) {
			_, err = c.EnsurePlayable(kind, id, filepath.Base(path))
			return err == nil
		}
	}
	return false
}

type RepairResult struct {
	OK       bool   `json:"ok"`
	Scanned  int    `json:"scanned"`
	Needed   int    `json:"needed"`
	Repaired int    `json:"repaired"`
	Skipped  int    `json:"skipped"`
	Failed   int    `json:"failed"`
	Message  string `json:"message"`
}

var repairMu sync.Mutex
var repairOn bool

func (c *Core) RepairTimestamps(channelID string, force bool) RepairResult {
	repairMu.Lock()
	if repairOn {
		repairMu.Unlock()
		return RepairResult{OK: true, Message: "已有修复任务在进行中，请稍候"}
	}
	repairOn = true
	repairMu.Unlock()
	defer func() {
		repairMu.Lock()
		repairOn = false
		repairMu.Unlock()
	}()
	if c.ffmpegPath() == "" {
		return RepairResult{OK: true, Message: "未找到 FFmpeg，无法修复"}
	}
	files := c.collectTS(channelID)
	res := RepairResult{OK: true}
	for _, path := range files {
		st, err := os.Stat(path)
		if err != nil || st.IsDir() || st.Size() < 64 {
			res.Skipped++
			continue
		}
		res.Scanned++
		if c.sourceWriting(path) || isSegmentWriting(st.ModTime().UnixMilli(), time.Now().UnixMilli()) {
			res.Skipped++
			continue
		}
		if !force && !c.tsNeedsRepair(path) {
			res.Skipped++
			continue
		}
		res.Needed++
		ok := false
		ok = c.normalizeTS(path)
		if ok {
			res.Repaired++
			_ = os.WriteFile(path+".normed", []byte("ok"), 0o644)
		} else {
			res.Failed++
		}
	}
	if res.Scanned == 0 {
		res.Message = "未找到可扫描的 .ts 录像"
	} else {
		res.Message = fmt.Sprintf("扫描 %d 个 · 需修复 %d · 已修复 %d", res.Scanned, res.Needed, res.Repaired)
		if res.Skipped > 0 {
			res.Message += fmt.Sprintf(" · 跳过 %d", res.Skipped)
		}
		if res.Failed > 0 {
			res.Message += fmt.Sprintf(" · 失败 %d", res.Failed)
		}
	}
	return res
}

func (c *Core) collectTS(channelID string) []string {
	ids := map[string]bool{}
	if channelID != "" {
		ids[channelID] = true
	} else {
		for _, ch := range c.Channels() {
			ids[ch.ID] = true
		}
		for _, root := range []string{c.recordingsRoot(), c.cacheRoot(), c.savedRoot()} {
			if root == "" {
				continue
			}
			entries, _ := os.ReadDir(root)
			for _, e := range entries {
				if e.IsDir() && safeChannelID(e.Name()) {
					ids[e.Name()] = true
				}
			}
		}
	}
	var out []string
	seen := map[string]bool{}
	for id := range ids {
		for _, dir := range []string{c.channelRecordDir(id), c.channelCacheDir(id), c.channelSavedDir(id)} {
			if dir == "" {
				continue
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".ts") {
					continue
				}
				p := filepath.Join(dir, e.Name())
				if seen[p] {
					continue
				}
				seen[p] = true
				out = append(out, p)
			}
		}
	}
	return out
}

func (c *Core) ExportRange(channelID string, startMs, endMs int64, dest string) (string, int, error) {
	return c.ExportRangeContext(context.Background(), channelID, startMs, endMs, dest)
}

func (c *Core) ExportRangeContext(parent context.Context, channelID string, startMs, endMs int64, dest string) (string, int, error) {
	ctx, cancel := c.mediaContext(parent)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return "", 0, err
	}
	select {
	case c.media.exportSlots <- struct{}{}:
		defer func() { <-c.media.exportSlots }()
	default:
		return "", 0, errStr("导出任务较多，请等待当前任务完成")
	}
	if startMs > endMs {
		startMs, endMs = endMs, startMs
	}
	if !safeChannelID(channelID) {
		return "", 0, errStr("通道无效")
	}
	segs := c.timed(channelID)
	hit := segmentsOverlapping(segs, startMs, endMs)
	if len(hit) == 0 {
		return "", 0, errStr("该时间范围没有录像")
	}
	if dest == "" {
		stamp := time.UnixMilli(startMs).Format("20060102-150405")
		nonce := make([]byte, 8)
		if _, err := rand.Read(nonce); err != nil {
			return "", 0, err
		}
		dest = filepath.Join(c.channelSavedDir(channelID), "clip-"+stamp+"-"+hex.EncodeToString(nonce)+".mp4")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", 0, err
	}
	releases := make([]func(), 0, len(hit))
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	for _, seg := range hit {
		release, err := c.media.leases.acquireContext(ctx, seg.Path)
		if err != nil {
			return "", 0, err
		}
		releases = append(releases, release)
	}
	lf, err := os.CreateTemp("", "navora-concat-*.txt")
	if err != nil {
		return "", 0, err
	}
	list := lf.Name()
	if err = lf.Close(); err != nil {
		os.Remove(list)
		return "", 0, err
	}
	defer os.Remove(list)
	output, err := os.CreateTemp(filepath.Dir(dest), ".navora-export-*.mp4")
	if err != nil {
		return "", 0, err
	}
	tmpOutput := output.Name()
	if err = output.Close(); err != nil {
		os.Remove(tmpOutput)
		return "", 0, err
	}
	defer os.Remove(tmpOutput)
	var b strings.Builder
	var outputProbe mediaProbe
	for i, s := range hit {
		probe, err := c.probeMedia(ctx, s.Path)
		if err != nil {
			return "", 0, err
		}
		if i == 0 {
			outputProbe = probe
		}
		origin, _ := strconv.ParseFloat(probe.Format.StartTime, 64)
		p := strings.ReplaceAll(filepath.ToSlash(s.Path), "'", `'\''`)
		b.WriteString("file '")
		b.WriteString(p)
		b.WriteString("'\n")
		from := max(startMs, s.StartMs)
		to := min(endMs, s.EndMs)
		if from > s.StartMs {
			b.WriteString("inpoint " + strconv.FormatFloat(origin+float64(from-s.StartMs)/1000, 'f', 6, 64) + "\n")
		}
		b.WriteString("outpoint " + strconv.FormatFloat(origin+float64(to-s.StartMs)/1000, 'f', 6, 64) + "\n")
		b.WriteString("duration " + strconv.FormatFloat(float64(to-from)/1000, 'f', 6, 64) + "\n")
	}
	if err := os.WriteFile(list, []byte(b.String()), 0o644); err != nil {
		return "", 0, err
	}
	defer os.Remove(list)
	bin := c.ffmpegPath()
	if bin == "" {
		return "", 0, errStr("未找到 FFmpeg")
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list}
	args = append(args, mp4StreamArgs(outputProbe)...)
	args = append(args, "-movflags", "+faststart", tmpOutput)
	runErr := c.media.work.run(backgroundMediaContext(ctx, 1), func() error {
		cmd := exec.CommandContext(ctx, bin, args...)
		hideWindow(cmd)
		stderr := tailBuf(2048)
		cmd.Stderr = stderr
		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("%w：%s", err, redactSecrets(stderr.String()))
		}
		finalProbe, err := c.probeMedia(ctx, tmpOutput)
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := publishNew(tmpOutput, dest); err != nil {
			return err
		}
		if samePath(filepath.Dir(dest), filepath.Join(c.savedRoot(), channelID)) {
			seconds, parseErr := strconv.ParseFloat(finalProbe.Format.Duration, 64)
			info, statErr := os.Stat(dest)
			if parseErr == nil && statErr == nil && seconds > 0 {
				actualStart := endMs
				for _, segment := range hit {
					actualStart = min(actualStart, max(startMs, segment.StartMs))
				}
				c.media.indexMu.Lock()
				path := filepath.Join(filepath.Dir(dest), "index.json")
				index := c.media.readIndex(path)
				duration := int64(seconds * 1000)
				index[filepath.Base(dest)] = indexEntry{FileName: filepath.Base(dest), StartMs: actualStart, EndMs: actualStart + duration,
					DurationMs: duration, SizeBytes: info.Size(), IndexedAt: time.Now().UnixMilli(), Measured: true,
					SourceVersion: strconv.FormatInt(info.Size(), 10) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 10)}
				c.media.writeIndex(path, index)
				c.media.indexMu.Unlock()
			}
		}
		return nil
	})
	if runErr != nil {
		return "", 0, errStr("导出失败：" + runErr.Error())
	}

	return dest, len(hit), nil
}

func abs64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func (c *Core) timed(channelID string) []timedSeg {
	var out []timedSeg
	for _, s := range c.ListRecordings(channelID) {
		if s.State != "ready" {
			continue
		}
		if s.StartMs == nil || s.EndMs == nil {
			continue
		}
		out = append(out, timedSeg{Path: s.Path, FileName: s.FileName, StartMs: *s.StartMs, EndMs: *s.EndMs})
	}
	return out
}

func (c *Core) SaveRecent(channelID string, durSec int) (int, string, []Segment, error) {
	if durSec <= 0 {
		durSec = c.Settings().SavedClipDurationSec
	}
	end := time.Now().UnixMilli()
	start := end - int64(durSec)*1000
	path, n, err := c.ExportRange(channelID, start, end, "")
	if err != nil {
		return 0, "", nil, err
	}
	return n, "已保存片段 " + filepath.Base(path), c.ListSaved(channelID), nil
}

func (c *Core) DeleteSaved(segmentID string) error {
	// id is channelId/fileName
	i := strings.IndexByte(segmentID, '/')
	if i <= 0 {
		return errStr("片段无效")
	}
	id, name := segmentID[:i], segmentID[i+1:]
	p, err := c.resolveMedia("saved", id, name)
	if err != nil {
		return errStr("找不到片段")
	}
	return c.removeMedia(p)
}

func (c *Core) SaveSnapshot(channelID, dataURL string) (string, error) {
	if !safeChannelID(channelID) {
		return "", errStr("通道无效")
	}
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 {
		return "", errStr("截图数据无效")
	}
	raw := dataURL[comma+1:]
	if len(raw) > 8_000_000 {
		return "", errStr("截图过大")
	}
	ext := ".png"
	if strings.Contains(dataURL[:comma], "jpeg") {
		ext = ".jpg"
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return "", err
	}
	name := time.Now().Format("20060102-150405") + ext
	path := filepath.Join(c.channelSnapDir(channelID), name)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func (c *Core) Probe(id string) (bool, int64, string) {
	c.mu.Lock()
	ch, ok := c.channelByID(id)
	c.mu.Unlock()
	if !ok {
		return false, 0, "通道不存在"
	}
	bin := c.ffmpegPath()
	if bin == "" {
		return false, 0, "未找到 FFmpeg"
	}
	start := time.Now()
	cmd := exec.Command(bin, buildProbeArgs(ch.URL, ch.RtspTransport)...)
	hideWindow(cmd)
	eb := tailBuf(2048)
	cmd.Stderr = eb
	err := cmd.Run()
	ms := time.Since(start).Milliseconds()
	if err != nil {
		msg := eb.String()
		if msg == "" {
			msg = "无法打开码流"
		}
		return false, ms, msg
	}
	return true, ms, "连通，耗时 " + strconv.FormatInt(ms, 10) + " ms"
}
