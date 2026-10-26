package core

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func (c *Core) videosRoot() string {
	return filepath.Join(c.root, "media")
}

func windowsSystemPath(p string) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	root := os.Getenv("SystemRoot")
	if root == "" {
		return false
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	return samePath(abs, root) || strings.HasPrefix(strings.ToLower(abs), strings.ToLower(filepath.Clean(root)+string(os.PathSeparator)))
}

// Pin legacy defaults only when there is existing content. Never move files or
// silently lose access to recordings written under the former service account.
func (c *Core) storageDefaults(s Settings, legacy bool) Settings {
	if s.RecordCachePath == "" {
		s.RecordCachePath = filepath.Join(c.root, "record-cache")
	}
	if !filepath.IsAbs(s.RecordCachePath) {
		s.RecordCachePath = filepath.Join(c.root, s.RecordCachePath)
	}
	home, _ := os.UserHomeDir()
	for _, item := range []struct {
		path *string
		leaf string
	}{
		{&s.RecordingsPath, "recordings"}, {&s.SavedClipsPath, "saved"}, {&s.SnapshotsPath, "snapshots"},
	} {
		if *item.path != "" {
			if !filepath.IsAbs(*item.path) {
				*item.path = filepath.Join(c.root, *item.path)
			}
			continue
		}
		*item.path = filepath.Join(c.videosRoot(), item.leaf)
		if legacy && home != "" {
			old := filepath.Join(home, "Videos", "Navora Monitor", item.leaf)
			if entries, err := os.ReadDir(old); err == nil && len(entries) > 0 {
				*item.path = old
			}
		}
	}
	return s
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
