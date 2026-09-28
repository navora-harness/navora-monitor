package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

var ffmpegCache struct {
	sync.Mutex
	preferred string
	path      string
	probed    time.Time
	ok        bool
}

func (c *Core) clearFFmpegCache() {
	ffmpegCache.Lock()
	ffmpegCache.preferred = ""
	ffmpegCache.path = ""
	ffmpegCache.probed = time.Time{}
	ffmpegCache.Unlock()
}

func (c *Core) ffmpegPath() string {
	c.mu.Lock()
	pref := strings.TrimSpace(c.settings.FFmpegPath)
	c.mu.Unlock()
	ffmpegCache.Lock()
	defer ffmpegCache.Unlock()
	if ffmpegCache.path != "" && ffmpegCache.preferred == pref {
		if st, err := os.Stat(ffmpegCache.path); err == nil && !st.IsDir() {
			return ffmpegCache.path
		}
		ffmpegCache.path = ""
	}
	if pref != "" {
		if st, err := os.Stat(pref); err == nil && !st.IsDir() {
			ffmpegCache.preferred = pref
			ffmpegCache.path = pref
			return pref
		}
	}
	for _, key := range []string{"NAVORA_MONITOR_FFMPEG", "FFMPEG_PATH"} {
		if p := os.Getenv(key); p != "" {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				ffmpegCache.preferred = pref
				ffmpegCache.path = p
				return p
			}
		}
	}
	if p := bundledFFmpeg(); p != "" {
		ffmpegCache.preferred = pref
		ffmpegCache.path = p
		return p
	}
	if p := ffmpegOnPath(); p != "" {
		ffmpegCache.preferred = pref
		ffmpegCache.path = p
		return p
	}
	return ""
}

func bundledFFmpeg() string {
	exeName := "ffmpeg"
	if runtime.GOOS == "windows" {
		exeName = "ffmpeg.exe"
	}
	var dirs []string
	if runtime.GOOS == "windows" {
		if runtime.GOARCH == "arm64" {
			dirs = []string{"win-arm64"}
		} else {
			dirs = []string{"win-x64", "win64"}
		}
	} else if runtime.GOOS == "linux" {
		if runtime.GOARCH == "arm64" {
			dirs = []string{"linux-arm64"}
		} else {
			dirs = []string{"linux-x64", "linux64"}
		}
	} else if runtime.GOOS == "darwin" {
		if runtime.GOARCH == "arm64" {
			dirs = []string{"darwin-arm64"}
		} else {
			dirs = []string{"darwin-x64"}
		}
	}
	var roots []string
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, cwd, filepath.Dir(cwd))
	}
	var cands []string
	for _, root := range roots {
		for _, d := range dirs {
			cands = append(cands, filepath.Join(root, "vendor", "ffmpeg", d, exeName))
		}
		cands = append(cands, filepath.Join(root, "vendor", "ffmpeg", exeName))
		cands = append(cands, filepath.Join(root, "ffmpeg", exeName))
	}
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func ffmpegOnPath() string {
	name := "ffmpeg"
	if runtime.GOOS == "windows" {
		name = "ffmpeg.exe"
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	if runtime.GOOS == "windows" {
		cands := []string{
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "ffmpeg", "bin", "ffmpeg.exe"),
			`C:\ffmpeg\bin\ffmpeg.exe`,
		}
		for _, c := range cands {
			if c == "" {
				continue
			}
			if st, err := os.Stat(c); err == nil && !st.IsDir() {
				return c
			}
		}
	}
	return ""
}

func (c *Core) ffprobePath() string {
	ff := c.ffmpegPath()
	if ff == "" {
		return ""
	}
	name := "ffprobe"
	if runtime.GOOS == "windows" {
		name = "ffprobe.exe"
	}
	p := filepath.Join(filepath.Dir(ff), name)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

func (c *Core) ffmpegOK() bool {
	p := c.ffmpegPath()
	if p == "" {
		return false
	}
	ffmpegCache.Lock()
	defer ffmpegCache.Unlock()
	if ffmpegCache.path == p && time.Since(ffmpegCache.probed) < time.Minute {
		return ffmpegCache.ok
	}
	cmd := exec.Command(p, "-version")
	hideWindow(cmd)
	err := cmd.Run()
	ffmpegCache.path = p
	ffmpegCache.probed = time.Now()
	ffmpegCache.ok = err == nil
	return ffmpegCache.ok
}

func hideWindow(cmd *exec.Cmd) {
	if runtime.GOOS != "windows" {
		return
	}
	attr := windowsHide()
	cmd.SysProcAttr = &attr
}

func tailBuf(max int) *limitedBuf {
	return &limitedBuf{max: max}
}

type limitedBuf struct {
	mu  sync.Mutex
	b   []byte
	max int
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.b = append(l.b, p...)
	if len(l.b) > l.max {
		l.b = append([]byte(nil), l.b[len(l.b)-l.max:]...)
	}
	return len(p), nil
}

func (l *limitedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.TrimSpace(string(l.b))
}
