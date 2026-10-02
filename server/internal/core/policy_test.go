package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStorageLevel(t *testing.T) {
	if evaluateStorageLevel(gb/2, 5, 1) != "critical" {
		t.Fatal("expected critical")
	}
	if evaluateStorageLevel(3*gb, 5, 1) != "warn" {
		t.Fatal("expected warn")
	}
	if evaluateStorageLevel(20*gb, 5, 1) != "ok" {
		t.Fatal("expected ok")
	}
	if cleanupTargetFreeBytes(5, 1) != 5*gb {
		t.Fatal("cleanup target")
	}
}

func TestSegmentWriting(t *testing.T) {
	now := int64(1_000_000)
	if !isSegmentWriting(now-1000, now) {
		t.Fatal("fresh file should be writing")
	}
	if isSegmentWriting(now-20_000, now) {
		t.Fatal("old file should be finished")
	}
}

func TestParseSegmentStart(t *testing.T) {
	ms, ok := parseSegmentStartMs("cam-20260928-121530.ts")
	if !ok {
		t.Fatal("expected parse")
	}
	dt := time.UnixMilli(ms).In(time.Now().Location())
	if dt.Year() != 2026 || dt.Month() != 9 || dt.Day() != 28 || dt.Hour() != 12 || dt.Minute() != 15 || dt.Second() != 30 {
		t.Fatalf("got %v", dt)
	}
	if isRecordingMediaFile("a.play.mp4") || isRecordingMediaFile("a.ts.normed") {
		t.Fatal("sidecars are not recordings")
	}
	if !isRecordingMediaFile("a.ts") {
		t.Fatal("ts is recording")
	}
}

func TestScheduleOvernight(t *testing.T) {
	s := &schedule{Enabled: true, Days: []int{1}, Start: "22:00", End: "06:00"}
	mondayLate := time.Date(2026, 9, 28, 23, 0, 0, 0, time.Local) // Monday
	if int(mondayLate.Weekday()) != 1 {
		t.Fatalf("fixture weekday %d", mondayLate.Weekday())
	}
	if !isScheduleActive(s, mondayLate) {
		t.Fatal("23:00 should be inside overnight window")
	}
	mondayMorning := time.Date(2026, 9, 28, 5, 0, 0, 0, time.Local)
	if !isScheduleActive(s, mondayMorning) {
		t.Fatal("05:00 should be inside overnight window")
	}
	mondayNoon := time.Date(2026, 9, 28, 12, 0, 0, 0, time.Local)
	if isScheduleActive(s, mondayNoon) {
		t.Fatal("noon should be outside")
	}
}

func TestHlsAndRecordArgs(t *testing.T) {
	live := strings.Join(buildMpegtsPreviewArgs("rtsp://cam/stream", "tcp", false), " ")
	for _, want := range []string{"-f mpegts", "+resend_headers", "pipe:1", "-an", "-c:v copy"} {
		if !strings.Contains(live, want) {
			t.Fatalf("mpegts preview args missing %s\n%s", want, live)
		}
	}
	hls := strings.Join(buildHlsPreviewArgs("rtsp://cam/stream", "tcp", "index.m3u8", "seg_%05d.ts"), " ")
	for _, want := range []string{"-hls_time 2", "-hls_list_size 8", "delete_segments+omit_endlist+temp_file", "-an", "-c:v copy"} {
		if !strings.Contains(hls, want) {
			t.Fatalf("hls args missing %s\n%s", want, hls)
		}
	}
	rec := strings.Join(buildSegmentRecordArgs("rtsp://cam/main", "out-%Y%m%d-%H%M%S.ts", "door", "tcp", 300), " ")
	for _, want := range []string{"-segment_format mpegts", "mpegts_flags=+resend_headers", "-avoid_negative_ts disabled", "dump_extra=freq=keyframe"} {
		if !strings.Contains(rec, want) {
			t.Fatalf("record args missing %s", want)
		}
	}
	norm := strings.Join(buildNormalizeTsArgs("a.ts", "b.ts", true), " ")
	if !strings.Contains(norm, "setts=ts=PTS-STARTPTS") {
		t.Fatal("normalize args")
	}
	x264 := strings.Join(buildMpegtsPreviewArgs("rtsp://cam/stream", "tcp", true), " ")
	for _, want := range []string{"libx264", "zerolatency", "scale=w=min(1280"} {
		if !strings.Contains(x264, want) {
			t.Fatalf("h264 preview args missing %s\n%s", want, x264)
		}
	}
	if strings.Contains(x264, "-c:v copy") {
		t.Fatalf("h264 preview still copies:\n%s", x264)
	}
}

func TestFilterLivePlaylistDropsMissing(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "seg_00010.ts"), []byte(strings.Repeat("x", 80)), 0o644); err != nil {
		t.Fatal(err)
	}
	raw := []byte("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg_00001.ts\n#EXTINF:2.0,\nseg_00010.ts\n")
	out := string(filterLivePlaylist(dir, raw))
	if strings.Contains(out, "seg_00001.ts") {
		t.Fatalf("deleted segment still listed:\n%s", out)
	}
	if !strings.Contains(out, "seg_00010.ts") || !strings.Contains(out, "#EXT-X-MEDIA-SEQUENCE:10") {
		t.Fatalf("live edge missing:\n%s", out)
	}
}

func TestTimelineDoesNotCollapseOverlap(t *testing.T) {
	start := int64(1_000_000_000_000)
	segs := []Segment{
		{StartMs: i64ptr(start), EndMs: i64ptr(start + 372_000)},
		{StartMs: i64ptr(start + 3_000), EndMs: i64ptr(start + 313_000)},
	}
	out := trimSegmentEnds(segs)
	if deref(out[0].EndMs) != start+372_000 {
		t.Fatalf("overlapping segment was cut to %d", deref(out[0].EndMs)-start)
	}
}

func TestTimelineCapsCopiedMtime(t *testing.T) {
	start := int64(1_000_000_000_000)
	segs := []Segment{
		{StartMs: i64ptr(start), EndMs: i64ptr(start + 3_404_000)},
		{StartMs: i64ptr(start + 333_000), EndMs: i64ptr(start + 633_000)},
	}
	out := trimSegmentEnds(segs)
	if deref(out[0].EndMs) != start+333_000 {
		t.Fatalf("inflated end not capped: %d", deref(out[0].EndMs)-start)
	}
	// Tiny file with a much-later mtime (cross-volume copy): bitrate too low → no stretch.
	_, gotEnd := estimateSegmentBounds(&start, start+3_404_000, nil, 300, 2_000_000, start+7_000_000)
	if gotEnd-start > 400_000 {
		t.Fatalf("copied mtime still stretches the bar: %d", gotEnd-start)
	}
}

func TestEstimateSegmentBoundsLongRealFile(t *testing.T) {
	start := int64(1_700_000_000_000)
	// ~1.1 GiB written for ~85 minutes — typical when ffmpeg waits on keyframes.
	mtime := start + 85*60_000
	now := mtime + 3600_000
	_, gotEnd := estimateSegmentBounds(&start, mtime, nil, 300, 1_200_000_000, now)
	if gotEnd-start < 80*60_000 {
		t.Fatalf("long real segment capped too aggressively: %d", gotEnd-start)
	}
}

func TestRetentionCutoffLocal(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	now := time.Date(2026, 10, 2, 21, 45, 0, 0, loc)
	cut := retentionCutoffLocal(3, now)
	want := time.Date(2026, 9, 30, 0, 0, 0, 0, loc)
	if !cut.Equal(want) {
		t.Fatalf("retention 3 days cut=%v want=%v", cut, want)
	}
	if !retentionCutoffLocal(1, now).Equal(time.Date(2026, 10, 2, 0, 0, 0, 0, loc)) {
		t.Fatal("retention 1 day should be start of today")
	}
}

func TestEstimateSegmentBounds(t *testing.T) {
	start := int64(1_700_000_000_000)
	mtime := start + 40_000
	now := mtime + 1000
	gotStart, gotEnd := estimateSegmentBounds(&start, mtime, nil, 300, 2_000_000, now)
	if gotStart != start || gotEnd != mtime {
		t.Fatalf("growing file: got %d-%d", gotStart, gotEnd)
	}
	if cachedRangePlausible(start, start+200_000, 100, 200, 300) {
		t.Fatal("size mismatch should miss cache")
	}
	if !cachedRangePlausible(start, start+200_000, 2_000_000, 2_000_000, 300) {
		t.Fatal("matching cache should hit")
	}
	// Short-capped cache on a huge file must miss so wall clock can re-estimate.
	if cachedRangePlausible(start, start+300_000, 1_200_000_000, 1_200_000_000, 300) {
		t.Fatal("short cache on huge file should miss")
	}
	// Long real-duration cache must remain usable.
	if !cachedRangePlausible(start, start+85*60_000, 1_200_000_000, 1_200_000_000, 300) {
		t.Fatal("long real cache should hit")
	}
}

func TestUsernameAndGroup(t *testing.T) {
	if sanitizeUsername("bad name") != "navora" {
		t.Fatal("reject space")
	}
	if sanitizeUsername("ops") != "ops" {
		t.Fatal("keep ops")
	}
	if normalizeGroupName("未分组") != defaultGroup || storedGroupValue("默认分组") != "" {
		t.Fatal("group normalize")
	}
	if !safeChannelID("cam-abc") || safeChannelID("../x") {
		t.Fatal("channel id")
	}
}

func TestFaststartSkipsMissingAudio(t *testing.T) {
	args := strings.Join(faststartAttemptArgs("in.ts", "out.mp4", faststartAttempts()[0]), " ")
	if !strings.Contains(args, "-map 0:a:0?") {
		t.Fatalf("optional audio map missing: %s", args)
	}
	if strings.Contains(args, "-map 0:a:0 ") || strings.HasSuffix(args, "-map 0:a:0") {
		t.Fatalf("audio map is required: %s", args)
	}
}

func TestRemuxSampleOptionalAudio(t *testing.T) {
	src := os.Getenv("NAVORA_REMUX_SAMPLE")
	if src == "" {
		t.Skip("NAVORA_REMUX_SAMPLE not set")
	}
	bin := bundledFFmpeg()
	if bin == "" {
		dir, _ := os.Getwd()
		for i := 0; i < 5 && bin == ""; i++ {
			p := filepath.Join(dir, "vendor", "ffmpeg", "win-x64", "ffmpeg.exe")
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				bin = p
			}
			dir = filepath.Dir(dir)
		}
	}
	if bin == "" {
		t.Fatal("ffmpeg missing")
	}
	dst := filepath.Join(t.TempDir(), "out.mp4")
	buf := tailBuf(2048)
	cmd := exec.Command(bin, faststartAttemptArgs(src, dst, faststartAttempts()[0])...)
	hideWindow(cmd)
	cmd.Stderr = buf
	if err := cmd.Run(); err != nil {
		t.Fatal(buf.String(), err)
	}
	st, err := os.Stat(dst)
	if err != nil || st.Size() < 64 {
		t.Fatalf("remux output missing: %v", err)
	}
}
