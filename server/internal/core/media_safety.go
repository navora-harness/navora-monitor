package core

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Leases and deletion share a lock: a candidate cannot disappear between
// checking its lease and acquiring a reader. Paths are canonical on Windows.
type fileLeases struct {
	mu      sync.Mutex
	readers map[string]int
	moving  map[string]bool
	changed chan struct{}
}

func leaseKey(path string) string {
	p, _ := filepath.Abs(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(filepath.Clean(p))
	}
	return filepath.Clean(p)
}

func (l *fileLeases) acquire(path string) func() {
	release, _ := l.acquireContext(context.Background(), path)
	return release
}

func (l *fileLeases) acquireContext(ctx context.Context, path string) (func(), error) {
	k := leaseKey(path)
	l.mu.Lock()
	for l.moving[k] {
		if l.changed == nil {
			l.changed = make(chan struct{})
		}
		changed := l.changed
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-changed:
		}
		l.mu.Lock()
	}
	if err := ctx.Err(); err != nil {
		l.mu.Unlock()
		return nil, err
	}
	if l.readers == nil {
		l.readers = map[string]int{}
	}
	l.readers[k]++
	l.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			l.readers[k]--
			if l.readers[k] == 0 {
				delete(l.readers, k)
			}
		})
	}, nil
}

func (l *fileLeases) remove(path string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readers[leaseKey(path)] > 0 || l.moving[leaseKey(path)] {
		return errors.New("文件正在使用")
	}
	return os.Remove(path)
}

func (l *fileLeases) move(src, dst string) error {
	l.mu.Lock()
	from, to := leaseKey(src), leaseKey(dst)
	if l.readers[from] > 0 || l.readers[to] > 0 || l.moving[from] || l.moving[to] {
		l.mu.Unlock()
		return errors.New("录像正在使用，稍后归档")
	}
	if l.moving == nil {
		l.moving = map[string]bool{}
	}
	if l.changed == nil {
		l.changed = make(chan struct{})
	}
	l.moving[from], l.moving[to] = true, true
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.moving, from)
		delete(l.moving, to)
		close(l.changed)
		l.changed = make(chan struct{})
		l.mu.Unlock()
	}()
	return moveFile(src, dst)
}

func (c *Core) mediaContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Minute)
	go func() {
		select {
		case <-c.shutdownCh:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

func (m *mediaKit) exclusiveContext(ctx context.Context, fn func() error) error {
	return m.runExclusive(ctx, m.sem, fn)
}

func (m *mediaKit) runExclusive(ctx context.Context, sem chan struct{}, fn func() error) error {
	select {
	case sem <- struct{}{}:
		defer func() { <-sem }()
		if err := ctx.Err(); err != nil {
			return err
		}
		return fn()
	case <-ctx.Done():
		return ctx.Err()
	}
}

type mediaProbe struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Duration  string `json:"duration"`
	} `json:"streams"`
	Format struct {
		Duration  string `json:"duration"`
		StartTime string `json:"start_time"`
	} `json:"format"`
}

func probeSeconds(value string) float64 {
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 {
		return 0
	}
	return seconds
}

// Video defines the recording timeline. An unrelated audio clock must not
// extend a five-minute camera recording to hours.
func videoDurationSeconds(probe mediaProbe) float64 {
	for _, stream := range probe.Streams {
		if stream.CodecType == "video" {
			if duration := probeSeconds(stream.Duration); duration > 0 {
				return duration
			}
			break
		}
	}
	return probeSeconds(probe.Format.Duration)
}

func needsAudioClockRepair(probe mediaProbe) bool {
	video := videoDurationSeconds(probe)
	if video <= 0 {
		return false
	}
	for _, stream := range probe.Streams {
		if stream.CodecType == "audio" && probeSeconds(probe.Format.Duration) > video+math.Max(5, video*0.05) {
			return true
		}
	}
	return false
}

func playbackRemuxArgs(input, output string, probe mediaProbe) []string {
	mid := mp4StreamArgs(probe)
	if needsAudioClockRepair(probe) {
		// Keep the video's original ordering while rebuilding audio timestamps
		// from decoded samples. Discontinuity correction otherwise shifts video
		// back and forth to follow the corrupt audio clock.
		mid = append(mid, "-bsf:v", "setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS", "-c:a", "aac", "-af", "asetpts=N/SR/TB")
		args := faststartAttemptArgs(input, output, mid)
		for i := 0; i+1 < len(args); {
			if args[i] == "-fflags" || args[i] == "-avoid_negative_ts" {
				args = append(args[:i], args[i+2:]...)
			} else {
				i++
			}
		}
		return append([]string{"-copyts", "-start_at_zero"}, args...)
	}
	return faststartAttemptArgs(input, output, mid)
}

// MP4 output must use browser-compatible audio and the HEVC sample-entry tag.
// Copy video to preserve quality and avoid making exports compete for encoding.
func mp4StreamArgs(probe mediaProbe) []string {
	videoCodec, audioCodec := "", ""
	for _, stream := range probe.Streams {
		if stream.CodecType == "video" && videoCodec == "" {
			videoCodec = stream.CodecName
		}
		if stream.CodecType == "audio" && audioCodec == "" {
			audioCodec = stream.CodecName
		}
	}
	args := []string{"-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"}
	if videoCodec == "hevc" {
		args = append(args, "-tag:v", "hvc1")
	}
	if audioCodec != "" && audioCodec != "aac" && audioCodec != "mp3" {
		return append(args, "-c:a", "aac", "-b:a", "128k")
	}
	return append(args, "-c:a", "copy")
}

func (c *Core) probeMedia(ctx context.Context, path string) (mediaProbe, error) {
	var p mediaProbe
	probe := c.ffprobePath()
	if probe == "" {
		return c.probeWithFFmpeg(ctx, path)
	}
	cmd := exec.CommandContext(ctx, probe, "-v", "error", "-analyzeduration", "30000000", "-probesize", "67108864", "-show_entries", "stream=codec_type,codec_name,width,height,duration:format=duration,start_time", "-of", "json", path)
	hideWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		return p, err
	}
	if err = json.Unmarshal(output, &p); err != nil {
		return p, err
	}
	for _, s := range p.Streams {
		if s.CodecType == "video" && s.Width > 0 && s.Height > 0 {
			return p, nil
		}
	}
	return p, errors.New("录像未读取到有效视频分辨率，可能缺少关键帧或文件损坏，请尝试相邻片段")
}

func (c *Core) removeMedia(path string) error {
	if c.media == nil {
		return errors.New("媒体服务未初始化")
	}
	return c.media.leases.remove(path)
}

// Older packages shipped ffmpeg without ffprobe. Its input metadata is a
// compatibility fallback; new packages include the structured probe binary.
func (c *Core) probeWithFFmpeg(ctx context.Context, path string) (mediaProbe, error) {
	var result mediaProbe
	cmd := exec.CommandContext(ctx, c.ffmpegPath(), "-hide_banner", "-analyzeduration", "30000000", "-probesize", "67108864", "-i", path)
	hideWindow(cmd)
	buf := tailBuf(16 * 1024)
	cmd.Stderr = buf
	_ = cmd.Run()
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	text := buf.String()
	if match := regexp.MustCompile(`start: (-?\d+(?:\.\d+)?)`).FindStringSubmatch(text); len(match) > 0 {
		result.Format.StartTime = match[1]
	}
	for _, match := range regexp.MustCompile(`(?m)Stream .*?(Video|Audio): ([a-zA-Z0-9_]+)([^\r\n]*)`).FindAllStringSubmatch(text, -1) {
		var stream struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
			Duration  string `json:"duration"`
		}
		stream.CodecType = strings.ToLower(match[1])
		stream.CodecName = match[2]
		if size := regexp.MustCompile(`(?:, |\s)(\d{2,5})x(\d{2,5})(?:[, \[])`).FindStringSubmatch(match[3]); len(size) > 0 {
			stream.Width, _ = strconv.Atoi(size[1])
			stream.Height, _ = strconv.Atoi(size[2])
		}
		result.Streams = append(result.Streams, stream)
	}
	if m := regexp.MustCompile(`Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`).FindStringSubmatch(text); len(m) > 0 {
		hours, _ := strconv.ParseFloat(m[1], 64)
		minutes, _ := strconv.ParseFloat(m[2], 64)
		seconds, _ := strconv.ParseFloat(m[3], 64)
		result.Format.Duration = strconv.FormatFloat(hours*3600+minutes*60+seconds, 'f', 6, 64)
	}
	for _, stream := range result.Streams {
		if stream.CodecType == "video" && stream.Width > 0 && stream.Height > 0 {
			return result, nil
		}
	}
	return result, errors.New("录像没有可识别的视频流")
}

func (c *Core) sourceWriting(path string) bool {
	active := c.activeRecordingPath(filepath.Base(filepath.Dir(path)))
	return active != "" && samePath(path, active)
}

func (c *Core) activeRecordingPath(id string) string {
	if c.rec == nil {
		return ""
	}
	c.rec.mu.Lock()
	session := c.rec.sess[id]
	dir := ""
	if session != nil {
		dir = session.dir
	}
	c.rec.mu.Unlock()
	if dir == "" || !c.rec.running(id) {
		return ""
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	newest := ""
	var at time.Time
	for _, entry := range entries {
		if entry.IsDir() || !isRecordingMediaFile(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err == nil && (newest == "" || info.ModTime().After(at) || info.ModTime().Equal(at) && entry.Name() > newest) {
			newest = entry.Name()
			at = info.ModTime()
		}
	}
	if newest == "" {
		return ""
	}
	return filepath.Join(dir, newest)
}
