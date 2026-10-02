package core

import (
	"crypto/rand"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	gb                    = 1024 * 1024 * 1024
	segmentWritingFreshMS = 12_000
	skewSec               = 1.5
	videoOrphanStartSec   = 60
	defaultGroup          = "默认分组"
	legacyDefaultGroup    = "未分组"
	segmentStrftimeSuffix = "%Y%m%d-%H%M%S.ts"
)

var (
	stampRe = regexp.MustCompile(`(\d{8})-(\d{6})(?:\.[^.]+)?$`)
	timeRe  = regexp.MustCompile(`^([01]?\d|2[0-3]):([0-5]\d)$`)
	userRe  = regexp.MustCompile(`^[A-Za-z0-9_@.\-]{1,32}$`)
)

const passwordAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*"

func generatePassword(n int) (string, error) {
	if n < 12 {
		n = 12
	}
	if n > 64 {
		n = 64
	}
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = passwordAlphabet[int(buf[i])%len(passwordAlphabet)]
	}
	return string(out), nil
}

func sanitizeUsername(raw string) string {
	t := strings.TrimSpace(raw)
	if t == "" || !userRe.MatchString(t) {
		return "navora"
	}
	return t
}

func evaluateStorageLevel(freeBytes uint64, warnFreeGb, stopFreeGb float64) string {
	freeGb := float64(freeBytes) / gb
	if stopFreeGb > 0 && freeGb < stopFreeGb {
		return "critical"
	}
	if warnFreeGb > 0 && freeGb < warnFreeGb {
		return "warn"
	}
	return "ok"
}

func cleanupTargetFreeBytes(warnFreeGb, stopFreeGb float64) int64 {
	if warnFreeGb > 0 {
		return int64(warnFreeGb * gb)
	}
	if stopFreeGb > 0 {
		return int64((stopFreeGb + 1) * gb)
	}
	return 0
}

func isSegmentWriting(mtimeMs, nowMs int64) bool {
	if mtimeMs <= 0 {
		return false
	}
	return nowMs-mtimeMs < segmentWritingFreshMS
}

func parseSegmentStartMs(fileName string) (int64, bool) {
	base := filepath.Base(fileName)
	m := stampRe.FindStringSubmatch(base)
	if m == nil {
		return 0, false
	}
	d, t := m[1], m[2]
	y, _ := strconv.Atoi(d[0:4])
	mo, _ := strconv.Atoi(d[4:6])
	day, _ := strconv.Atoi(d[6:8])
	h, _ := strconv.Atoi(t[0:2])
	mi, _ := strconv.Atoi(t[2:4])
	s, _ := strconv.Atoi(t[4:6])
	loc := time.Now().Location()
	dt := time.Date(y, time.Month(mo), day, h, mi, s, 0, loc)
	return dt.UnixMilli(), true
}

func isRecordingMediaFile(name string) bool {
	lower := strings.ToLower(name)
	if strings.HasSuffix(lower, ".play.mp4") || strings.HasSuffix(lower, ".play.mp4.meta") {
		return false
	}
	if strings.HasSuffix(lower, ".normed") || strings.HasSuffix(lower, ".norm.ts") {
		return false
	}
	return strings.HasSuffix(lower, ".ts") || strings.HasSuffix(lower, ".mp4") || strings.HasSuffix(lower, ".mkv")
}

type schedule struct {
	Enabled bool   `json:"enabled"`
	Days    []int  `json:"days"`
	Start   string `json:"start"`
	End     string `json:"end"`
}

func parseHm(raw string) (int, bool) {
	m := timeRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	return h*60 + mi, true
}

func isScheduleActive(s *schedule, now time.Time) bool {
	if s == nil || !s.Enabled {
		return false
	}
	day := int(now.Weekday())
	okDay := false
	for _, d := range s.Days {
		if d == day {
			okDay = true
			break
		}
	}
	if !okDay {
		return false
	}
	start, ok1 := parseHm(s.Start)
	end, ok2 := parseHm(s.End)
	if !ok1 || !ok2 {
		return false
	}
	mins := now.Hour()*60 + now.Minute()
	if start == end {
		return true
	}
	if start < end {
		return mins >= start && mins < end
	}
	return mins >= start || mins < end
}

func normalizeGroupName(name string) string {
	n := strings.TrimSpace(name)
	if n == "" || n == legacyDefaultGroup || n == defaultGroup {
		return defaultGroup
	}
	return n
}

func storedGroupValue(name string) string {
	n := normalizeGroupName(name)
	if n == defaultGroup {
		return ""
	}
	return n
}

func channelGroup(group string) string {
	return normalizeGroupName(group)
}

func sanitizeFileStem(raw string) string {
	s := strings.TrimSpace(raw)
	var b strings.Builder
	prevUnderscore := false
	for _, r := range s {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			if !prevUnderscore {
				b.WriteByte('_')
				prevUnderscore = true
			}
			continue
		}
		if r == ' ' || r == '\t' {
			if !prevUnderscore {
				b.WriteByte('_')
				prevUnderscore = true
			}
			continue
		}
		prevUnderscore = false
		b.WriteRune(r)
	}
	out := strings.Trim(b.String(), "._")
	for strings.Contains(out, "__") {
		out = strings.ReplaceAll(out, "__", "_")
	}
	if utf8.RuneCountInString(out) > 64 {
		rs := []rune(out)
		out = string(rs[:64])
	}
	if out == "" {
		return "channel"
	}
	return out
}

func safeChannelID(id string) bool {
	if id == "" || len(id) > 80 {
		return false
	}
	if strings.Contains(id, "..") || strings.ContainsAny(id, `/\`) {
		return false
	}
	return true
}

type timedSeg struct {
	Path     string
	FileName string
	StartMs  int64
	EndMs    int64
}

func segmentsOverlapping(segs []timedSeg, a, b int64) []timedSeg {
	if b < a {
		a, b = b, a
	}
	if !(b > a) {
		return nil
	}
	var out []timedSeg
	for _, s := range segs {
		if s.EndMs > a && s.StartMs < b {
			out = append(out, s)
		}
	}
	for i := 1; i < len(out); i++ {
		j := i
		for j > 0 && (out[j].StartMs < out[j-1].StartMs || (out[j].StartMs == out[j-1].StartMs && out[j].FileName < out[j-1].FileName)) {
			out[j], out[j-1] = out[j-1], out[j]
			j--
		}
	}
	return out
}

func buildSegmentRecordArgs(inputURL, outputPattern, title, transport string, segmentTime int) []string {
	if segmentTime < 10 {
		segmentTime = 300
	}
	args := []string{
		"-hide_banner", "-loglevel", "warning", "-y",
		"-fflags", "+nobuffer+discardcorrupt",
		"-flags", "low_delay",
		"-max_delay", "500000",
		"-probesize", "1000000",
		"-analyzeduration", "1000000",
		"-thread_queue_size", "64",
	}
	if strings.HasPrefix(strings.ToLower(inputURL), "rtsp://") {
		if transport != "udp" {
			transport = "tcp"
		}
		args = append(args, "-rtsp_transport", transport)
	}
	args = append(args,
		"-i", inputURL,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-c", "copy",
		"-bsf:v", "dump_extra=freq=keyframe",
		"-reset_timestamps", "1",
		"-avoid_negative_ts", "disabled",
		"-muxdelay", "0",
		"-muxpreload", "0",
		"-metadata", "title="+title,
		"-f", "segment",
		"-segment_time", strconv.Itoa(segmentTime),
		"-break_non_keyframes", "0",
		"-strftime", "1",
		"-segment_format", "mpegts",
		"-segment_format_options", "mpegts_flags=+resend_headers",
		outputPattern,
	)
	return args
}

func buildMpegtsPreviewArgs(inputURL, transport string, transcodeH264 bool) []string {
	args := []string{
		"-hide_banner", "-loglevel", "warning",
		"-fflags", "nobuffer+genpts+discardcorrupt",
		"-flags", "low_delay",
		"-max_delay", "500000",
		"-probesize", "500000",
		"-analyzeduration", "500000",
		"-thread_queue_size", "32",
	}
	if strings.HasPrefix(strings.ToLower(inputURL), "rtsp://") {
		if transport != "udp" {
			transport = "tcp"
		}
		args = append(args, "-rtsp_transport", transport)
	}
	args = append(args, "-i", inputURL, "-an")
	if transcodeH264 {
		args = append(args,
			"-vf", `scale=w=min(1280\,iw):h=-2`,
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-profile:v", "high",
			"-pix_fmt", "yuv420p",
			"-bf", "0",
			"-g", "50",
			"-keyint_min", "25",
			"-sc_threshold", "0",
			"-b:v", "2500k",
			"-maxrate", "3000k",
			"-bufsize", "1500k",
		)
	} else {
		args = append(args, "-c:v", "copy")
	}
	args = append(args,
		"-f", "mpegts",
		"-mpegts_flags", "+resend_headers",
		"-muxdelay", "0",
		"-muxpreload", "0",
		"-flush_packets", "1",
		"pipe:1",
	)
	return args
}

func buildHlsPreviewArgs(inputURL, transport, indexPath, segPattern string) []string {
	args := []string{
		"-hide_banner", "-loglevel", "warning", "-y",
		"-fflags", "nobuffer+discardcorrupt",
		"-flags", "low_delay",
		"-max_delay", "500000",
		"-probesize", "500000",
		"-analyzeduration", "500000",
		"-thread_queue_size", "32",
	}
	if strings.HasPrefix(strings.ToLower(inputURL), "rtsp://") {
		if transport != "udp" {
			transport = "tcp"
		}
		args = append(args, "-rtsp_transport", transport)
	}
	args = append(args,
		"-i", inputURL,
		"-an",
		"-c:v", "copy",
		"-f", "hls",
		"-hls_time", "2",
		"-hls_list_size", "8",
		"-hls_flags", "delete_segments+omit_endlist+temp_file",
		"-hls_segment_filename", segPattern,
		indexPath,
	)
	return args
}

func buildNormalizeTsArgs(input, output string, includeAudio bool) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", input,
		"-map", "0:v:0",
	}
	if includeAudio {
		args = append(args, "-map", "0:a:0?")
	}
	args = append(args, "-c", "copy", "-bsf:v", "setts=ts=PTS-STARTPTS")
	if includeAudio {
		args = append(args, "-bsf:a", "setts=ts=PTS-STARTPTS")
	}
	args = append(args, "-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", output)
	return args
}

func faststartAttemptArgs(input, output string, mid []string) []string {
	args := []string{
		"-hide_banner", "-loglevel", "error", "-y",
		"-fflags", "+genpts+igndts",
		"-i", input,
	}
	args = append(args, mid...)
	args = append(args,
		"-movflags", "+faststart",
		"-avoid_negative_ts", "make_zero",
		output,
	)
	return args
}

func faststartAttempts() [][]string {
	return [][]string{
		{"-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-tag:v", "hvc1"},
		{"-map", "0:v:0", "-map", "0:a:0?", "-c", "copy"},
		{"-map", "0:v:0", "-c", "copy", "-tag:v", "hvc1"},
		{"-map", "0:v:0", "-c", "copy"},
	}
}

func buildProbeArgs(inputURL, transport string) []string {
	args := []string{"-hide_banner", "-loglevel", "error"}
	if strings.HasPrefix(strings.ToLower(inputURL), "rtsp://") {
		if transport != "udp" {
			transport = "tcp"
		}
		args = append(args, "-rtsp_transport", transport)
	}
	args = append(args, "-i", inputURL, "-t", "3", "-f", "null", "-")
	return args
}

const absoluteMaxSegmentMs int64 = 24 * 3600 * 1000

func nominalSegmentMs(segmentTimeSec int) int64 {
	if segmentTimeSec < 10 {
		segmentTimeSec = 10
	}
	return int64(segmentTimeSec) * 1000
}

func durationFitsSize(durationMs, sizeBytes int64) bool {
	if sizeBytes <= 0 || durationMs <= 0 {
		return true
	}
	bps := sizeBytes * 1000 / durationMs
	if bps > 10_000_000 {
		return false
	}
	if durationMs > 3_600_000 && sizeBytes < 64_000 {
		return false
	}
	// Very long duration with tiny bitrate (< ~80 kbps) — typical bogus MPEG-TS probe
	// or a short clip whose mtime was rewritten long after it closed.
	if durationMs > 30*60_000 && bps < 10_000 {
		return false
	}
	return true
}

// estimateSegmentBounds matches shared/segment-range.ts so the web timeline
// paints the same bars as the previous desktop window.
func estimateSegmentBounds(parsedStart *int64, mtimeMs int64, probed *int64, segmentTimeSec int, sizeBytes, nowMs int64) (int64, int64) {
	nominal := nominalSegmentMs(segmentTimeSec)
	recent := nowMs-mtimeMs < 90_000
	var probe int64
	hasProbe := false
	if probed != nil && *probed > 0 && *probed <= absoluteMaxSegmentMs && durationFitsSize(*probed, sizeBytes) {
		probe = *probed
		hasProbe = true
	}
	if parsedStart != nil {
		start := *parsedStart
		var wall int64
		hasWall := false
		if mtimeMs > start && mtimeMs-start <= absoluteMaxSegmentMs {
			wall = mtimeMs - start
			hasWall = true
		}
		if recent && hasWall {
			if hasProbe && probe > wall {
				return start, start + probe
			}
			end := mtimeMs
			if end < start+500 {
				end = start + 500
			}
			return start, end
		}
		if hasProbe {
			return start, start + probe
		}
		// Fallback: wall clock (mtime − filename start), same as shared/segment-range.ts.
		// durationFitsSize rejects late-copy mtimes that imply absurd bitrates.
		if hasWall && durationFitsSize(wall, sizeBytes) {
			return start, start + wall
		}
		end := start + nominal
		if mtimeMs > start && mtimeMs-start < nominal*2 && mtimeMs > end {
			end = mtimeMs
		}
		if end <= start {
			end = start + 1000
		}
		return start, end
	}
	end := mtimeMs
	duration := nominal
	if hasProbe {
		duration = probe
	}
	if !durationFitsSize(duration, sizeBytes) && sizeBytes > 0 {
		guess := (sizeBytes * 8 / 2_000_000) * 1000
		if guess < nominal {
			guess = nominal
		}
		if guess > absoluteMaxSegmentMs {
			guess = absoluteMaxSegmentMs
		}
		duration = guess
	}
	start := end - duration
	if start >= end {
		start = end - 1000
	}
	return start, end
}

func cachedRangePlausible(start, end, cachedSize, sizeBytes int64, segmentTimeSec int) bool {
	if cachedSize != sizeBytes {
		return false
	}
	if end <= start {
		return false
	}
	dur := end - start
	if !durationFitsSize(dur, sizeBytes) {
		return false
	}
	nominal := nominalSegmentMs(segmentTimeSec)
	softMax := nominal * 25 / 10
	floor := int64(8_000_000)
	rateFloor := nominal / 1000 * 250_000
	if rateFloor > floor {
		floor = rateFloor
	}
	// Invalidate old "capped to ~segmentTime" entries for large files so
	// ListRecordings re-estimates from wall clock / size.
	if dur <= softMax && sizeBytes >= floor && dur <= nominal*115/100 {
		return false
	}
	return true
}

// retentionCutoffLocal is the earliest local wall time that may be kept when
// RetentionDays = days. days=3 on Oct 2 keeps from Sep 30 00:00 local onward
// (today + previous days-1 calendar days).
func retentionCutoffLocal(days int, now time.Time) time.Time {
	if days <= 0 {
		return time.Time{}
	}
	loc := now.Location()
	y, m, d := now.In(loc).Date()
	startToday := time.Date(y, m, d, 0, 0, 0, 0, loc)
	if days == 1 {
		return startToday
	}
	return startToday.AddDate(0, 0, -(days - 1))
}

// recordingContentTime returns the best-effort content timestamp for retention.
// Prefer filename stamp (matches timeline), else mtime.
func recordingContentTime(path string, mod time.Time) time.Time {
	if start, ok := parseSegmentStartMs(filepath.Base(path)); ok && start > 0 {
		return time.UnixMilli(start)
	}
	return mod
}
