package core

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	c          *Core
	sem        chan struct{}
	mu         sync.Mutex
	disk       diskSnap
	lastAction map[string]any
}

type diskSnap struct {
	at   time.Time
	info DiskInfo
}

type DiskInfo struct {
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
	return &mediaKit{c: c, sem: make(chan struct{}, 1)}
}

func (m *mediaKit) withExclusive(fn func()) {
	m.sem <- struct{}{}
	defer func() { <-m.sem }()
	fn()
}

func (c *Core) Disk() DiskInfo {
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
	rate := c.writeRate()
	var remain *float64
	if rate > 0 && free > 0 {
		v := float64(free) / rate
		remain = &v
	}
	var need *float64
	fit := true
	if rate > 0 && s.RetentionDays > 0 {
		v := rate * float64(s.RetentionDays) * 86400
		need = &v
		if v > float64(free) {
			fit = false
			if level == "ok" {
				level = "warn"
			}
		}
	}
	ratio := 0.0
	if total > 0 {
		ratio = float64(free) / float64(total)
	}
	return DiskInfo{
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
	type sample struct {
		dir string
		el  float64
	}
	c.rec.mu.Lock()
	var samples []sample
	for _, s := range c.rec.sess {
		el := time.Since(s.started).Seconds()
		if el < 15 || s.dir == "" {
			continue
		}
		samples = append(samples, sample{s.dir, el})
	}
	c.rec.mu.Unlock()
	var rate float64
	for _, s := range samples {
		rate += float64(dirSize(s.dir)) / s.el
	}
	return rate
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
		c.cleanupOlderThan(time.Duration(s.RetentionDays) * 24 * time.Hour)
	}
}

func (c *Core) cleanupUntil(target int64) {
	if target <= 0 {
		return
	}
	files := c.loopFiles()
	var deleted int
	var freed uint64
	for _, f := range files {
		free, _, err := diskUsage(c.recordingsRoot())
		if err != nil || int64(free) >= target {
			break
		}
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		if os.Remove(f) == nil {
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

func (c *Core) cleanupOlderThan(age time.Duration) {
	cut := time.Now().Add(-age)
	var deleted int
	var freed uint64
	for _, f := range c.loopFiles() {
		st, err := os.Stat(f)
		if err != nil || st.ModTime().After(cut) {
			continue
		}
		if os.Remove(f) == nil {
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
	var files []string
	root := c.recordingsRoot()
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil || info.IsDir() {
			return nil
		}
		if isRecordingMediaFile(info.Name()) {
			files = append(files, path)
		}
		return nil
	})
	for i := 1; i < len(files); i++ {
		j := i
		for j > 0 && olderFile(files[j], files[j-1]) {
			files[j], files[j-1] = files[j-1], files[j]
			j--
		}
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
		_ = os.Remove(f)
	}
	c.noteAction(map[string]any{"type": "cleanup", "message": "已清空循环录像", "at": time.Now().UnixMilli()})
	return c.Disk()
}

func (c *Core) RunCleanup() DiskInfo {
	s := c.Settings()
	c.cleanupUntil(cleanupTargetFreeBytes(s.DiskWarnFreeGb, s.DiskStopFreeGb))
	if s.RetentionDays > 0 {
		c.cleanupOlderThan(time.Duration(s.RetentionDays) * 24 * time.Hour)
	}
	return c.Disk()
}

type Segment struct {
	ID          string  `json:"id"`
	ChannelID   string  `json:"channelId"`
	FileName    string  `json:"fileName"`
	Path        string  `json:"path"`
	URL         string  `json:"url"`
	PlaybackURL *string `json:"playbackUrl"`
	SizeBytes   int64   `json:"sizeBytes"`
	MtimeMs     int64   `json:"mtimeMs"`
	StartMs     *int64  `json:"startMs"`
	EndMs       *int64  `json:"endMs"`
	Protected   bool    `json:"protected,omitempty"`
	SavedAt     *int64  `json:"savedAt,omitempty"`
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
	segSec := c.Settings().DefaultSegmentTimeSec
	if segSec < 10 {
		segSec = 300
	}
	out := []Segment{}
	now := time.Now().UnixMilli()
	for _, id := range ids {
		if !safeChannelID(id) {
			continue
		}
		var dirs []string
		indexPath := ""
		if kind == "saved" {
			dirs = []string{filepath.Join(c.savedRoot(), id)}
		} else {
			rec := filepath.Join(c.recordingsRoot(), id)
			dirs = []string{rec}
			indexPath = filepath.Join(rec, "index.json")
			if cache := c.cacheRoot(); cache != "" {
				dirs = append(dirs, filepath.Join(cache, id))
			}
		}
		index := readIndex(indexPath)
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
				if info.Size() < 64 && now-mtime > 180_000 {
					continue
				}
				seen[name] = true
				start, end, updated := segmentBounds(name, info, index[name], segSec, now)
				if updated != nil && !protected {
					index[name] = *updated
					dirty = true
				}
				fileURL := "/media/files/" + kind + "/" + id + "/" + name
				pb := fileURL
				seg := Segment{
					ID:          id + "/" + name,
					ChannelID:   id,
					FileName:    name,
					Path:        filepath.Join(dir, name),
					URL:         fileURL,
					PlaybackURL: &pb,
					SizeBytes:   info.Size(),
					MtimeMs:     mtime,
					StartMs:     i64ptr(start),
					EndMs:       i64ptr(end),
					Protected:   protected,
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
					delete(index, name)
					dirty = true
				}
			}
			if dirty && indexPath != "" {
				writeIndex(indexPath, index)
			}
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
	FileName   string `json:"fileName"`
	StartMs    int64  `json:"startMs"`
	EndMs      int64  `json:"endMs"`
	DurationMs int64  `json:"durationMs"`
	SizeBytes  int64  `json:"sizeBytes"`
	IndexedAt  int64  `json:"indexedAt"`
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
		DurationMs: end - start, SizeBytes: size, IndexedAt: now,
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
	for i := 0; i < len(segs)-1; i++ {
		curEnd := deref(segs[i].EndMs)
		nextStart := deref(segs[i+1].StartMs)
		gap := nextStart - curEnd
		if gap > 0 && gap <= 90_000 && nextStart > deref(segs[i].StartMs) {
			segs[i].EndMs = i64ptr(nextStart)
		}
	}
	return segs
}

func writeIndex(path string, index map[string]indexEntry) {
	segs := make([]indexEntry, 0, len(index))
	for _, s := range index {
		segs = append(segs, s)
	}
	sort.Slice(segs, func(i, j int) bool { return segs[i].StartMs < segs[j].StartMs })
	doc := struct {
		Version  int          `json:"version"`
		Segments []indexEntry `json:"segments"`
	}{Version: 1, Segments: segs}
	b, err := json.Marshal(doc)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
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
	for _, dir := range dirs {
		p := filepath.Join(dir, name)
		st, err := os.Stat(p)
		if err == nil && !st.IsDir() {
			return p, nil
		}
		if err != nil {
			last = err
		}
	}
	if last == nil {
		last = os.ErrNotExist
	}
	return "", last
}

func (c *Core) EnsurePlayable(kind, id, name string) (string, error) {
	src, err := c.resolveMedia(kind, id, name)
	if err != nil {
		return "", err
	}
	if strings.HasSuffix(strings.ToLower(name), ".mp4") {
		return src, nil
	}
	st, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	sum := sha1.Sum([]byte(src))
	key := hex.EncodeToString(sum[:8]) + "-" + strconv.FormatInt(st.Size(), 10) + "-" + strconv.FormatInt(st.ModTime().Unix(), 10) + ".mp4"
	dst := filepath.Join(c.playCacheDir(), key)
	if st2, err := os.Stat(dst); err == nil && st2.Size() > 64 {
		c.trimPlayCache()
		return dst, nil
	}
	var outErr error
	c.media.withExclusive(func() {
		if st2, err := os.Stat(dst); err == nil && st2.Size() > 64 {
			return
		}
		bin := c.ffmpegPath()
		if bin == "" {
			outErr = errStr("未找到 FFmpeg")
			return
		}
		tmp := dst + ".part.mp4"
		_ = os.Remove(tmp)
		var last string
		ok := false
		for _, mid := range faststartAttempts() {
			_ = os.Remove(tmp)
			buf := tailBuf(2048)
			cmd := exec.Command(bin, faststartAttemptArgs(src, tmp, mid)...)
			hideWindow(cmd)
			cmd.Stderr = buf
			err := cmd.Run()
			stOut, stErr := os.Stat(tmp)
			if err == nil && stErr == nil && stOut.Size() >= 64 {
				ok = true
				break
			}
			last = buf.String()
			if last == "" && err != nil {
				last = err.Error()
			}
			if last == "" {
				last = "转封装产物过小"
			}
		}
		if !ok {
			_ = os.Remove(tmp)
			if len(last) > 180 {
				last = last[len(last)-180:]
			}
			outErr = errStr("无法封装为 MP4：" + last)
			return
		}
		if err := os.Rename(tmp, dst); err != nil {
			outErr = err
		}
	})
	if outErr != nil {
		return "", outErr
	}
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
		if err != nil {
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
		if total <= capBytes {
			break
		}
		if os.Remove(f.path) == nil {
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

func (c *Core) normalizeTS(path string) bool {
	if !strings.HasSuffix(strings.ToLower(path), ".ts") {
		return false
	}
	bin := c.ffmpegPath()
	if bin == "" {
		return false
	}
	before, err := os.Stat(path)
	if err != nil || before.Size() < 64 {
		return false
	}
	tmp := path + ".norm.ts"
	run := func(audio bool) error {
		_ = os.Remove(tmp)
		cmd := exec.Command(bin, buildNormalizeTsArgs(path, tmp, audio)...)
		hideWindow(cmd)
		return cmd.Run()
	}
	if err := run(true); err != nil {
		if err2 := run(false); err2 != nil {
			_ = os.Remove(tmp)
			return false
		}
	}
	after, err := os.Stat(tmp)
	if err != nil || after.Size() < 64 || after.Size() < before.Size()/2 {
		_ = os.Remove(tmp)
		return false
	}
	_ = os.Remove(path)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return false
	}
	_ = os.Chtimes(path, before.ModTime(), before.ModTime())
	return true
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
		if isSegmentWriting(st.ModTime().UnixMilli(), time.Now().UnixMilli()) {
			res.Skipped++
			continue
		}
		if !force && !c.tsNeedsRepair(path) {
			res.Skipped++
			continue
		}
		res.Needed++
		ok := false
		c.media.withExclusive(func() { ok = c.normalizeTS(path) })
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
		dest = filepath.Join(c.channelSavedDir(channelID), "clip-"+stamp+".mp4")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", 0, err
	}
	list := filepath.Join(os.TempDir(), "navora-concat-"+channelID+".txt")
	var b strings.Builder
	for _, s := range hit {
		p := strings.ReplaceAll(filepath.ToSlash(s.Path), "'", `'\''`)
		b.WriteString("file '")
		b.WriteString(p)
		b.WriteString("'\n")
	}
	if err := os.WriteFile(list, []byte(b.String()), 0o644); err != nil {
		return "", 0, err
	}
	defer os.Remove(list)
	bin := c.ffmpegPath()
	if bin == "" {
		return "", 0, errStr("未找到 FFmpeg")
	}
	seek := 0.0
	if startMs > hit[0].StartMs {
		seek = float64(startMs-hit[0].StartMs) / 1000
	}
	dur := float64(abs64(endMs-startMs)) / 1000
	if dur < 0.2 {
		dur = 0.2
	}
	args := []string{"-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list}
	if seek > 0.05 {
		args = append(args, "-ss", strconv.FormatFloat(seek, 'f', 3, 64))
	}
	args = append(args, "-t", strconv.FormatFloat(dur, 'f', 3, 64), "-c", "copy", "-movflags", "+faststart", dest)
	var runErr error
	c.media.withExclusive(func() {
		cmd := exec.Command(bin, args...)
		hideWindow(cmd)
		runErr = cmd.Run()
	})
	if runErr != nil {
		return "", 0, errStr("导出失败")
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
	return os.Remove(p)
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
