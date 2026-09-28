package core

import (
	"os"
	"path/filepath"
	"runtime"
)

func (c *Core) videosRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(c.root, "media")
	}
	return filepath.Join(home, "Videos", "Navora Monitor")
}

func (c *Core) recordingsRoot() string {
	c.mu.Lock()
	p := c.settings.RecordingsPath
	c.mu.Unlock()
	if p == "" {
		p = filepath.Join(c.videosRoot(), "recordings")
	}
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) snapshotsRoot() string {
	c.mu.Lock()
	p := c.settings.SnapshotsPath
	c.mu.Unlock()
	if p == "" {
		p = filepath.Join(c.videosRoot(), "snapshots")
	}
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) savedRoot() string {
	c.mu.Lock()
	p := c.settings.SavedClipsPath
	c.mu.Unlock()
	if p == "" {
		p = filepath.Join(c.videosRoot(), "saved")
	}
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) cacheRoot() string {
	c.mu.Lock()
	p := c.settings.RecordCachePath
	on := c.settings.RecordCacheEnabled
	c.mu.Unlock()
	if !on {
		return ""
	}
	if p == "" {
		p = filepath.Join(c.root, "record-cache")
	}
	_ = os.MkdirAll(p, 0o755)
	rec, _ := filepath.Abs(c.recordingsRoot())
	abs, _ := filepath.Abs(p)
	if abs == rec {
		return ""
	}
	return p
}

func (c *Core) channelRecordDir(id string) string {
	p := filepath.Join(c.recordingsRoot(), id)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) channelSavedDir(id string) string {
	p := filepath.Join(c.savedRoot(), id)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) channelCacheDir(id string) string {
	root := c.cacheRoot()
	if root == "" {
		return ""
	}
	p := filepath.Join(root, id)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) channelSnapDir(id string) string {
	p := filepath.Join(c.snapshotsRoot(), id)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) previewDir(id string) string {
	p := filepath.Join(c.root, "preview", id)
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) playCacheDir() string {
	p := filepath.Join(c.root, "play-cache")
	_ = os.MkdirAll(p, 0o755)
	return p
}

func (c *Core) writeDir(id string) (string, bool) {
	if d := c.channelCacheDir(id); d != "" {
		return d, true
	}
	return c.channelRecordDir(id), false
}

func samePath(a, b string) bool {
	aa, ea := filepath.Abs(a)
	bb, eb := filepath.Abs(b)
	if ea != nil || eb != nil {
		return a == b
	}
	if runtime.GOOS == "windows" {
		return stringsEqualFold(aa, bb)
	}
	return aa == bb
}

func stringsEqualFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}
