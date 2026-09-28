package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type FsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
}

func (c *Core) ListFS(path, mode string) ([]FsEntry, string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return listRoots(), "", nil
	}
	path = filepath.Clean(path)
	// Windows: Clean("/") becomes "\", which is not a useful browse root.
	if path == string(filepath.Separator) || path == "." {
		return listRoots(), "", nil
	}
	st, err := os.Stat(path)
	if err != nil || !st.IsDir() {
		return nil, path, errStr("目录不存在")
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, path, err
	}
	var out []FsEntry
	for _, e := range entries {
		name := e.Name()
		if name == "" || name == "." || name == ".." {
			continue
		}
		if strings.HasPrefix(name, ".") {
			continue
		}
		full := filepath.Join(path, name)
		isDir := e.IsDir()
		if !isDir {
			if info, err := e.Info(); err == nil {
				isDir = info.IsDir() || info.Mode()&os.ModeSymlink != 0 && dirExists(full)
			}
		}
		if !isDir {
			switch mode {
			case "ffmpeg":
				low := strings.ToLower(name)
				if low != "ffmpeg" && low != "ffmpeg.exe" && !strings.HasSuffix(low, ".exe") {
					continue
				}
			case "json":
				if !strings.HasSuffix(strings.ToLower(name), ".json") {
					continue
				}
			case "dir":
				// Keep files visible so the picker does not look empty.
			default:
				// Unknown mode: show everything.
			}
		}
		out = append(out, FsEntry{Name: name, Path: full, Dir: isDir})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, path, nil
}

func dirExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

func listRoots() []FsEntry {
	var out []FsEntry
	for letter := 'A'; letter <= 'Z'; letter++ {
		root := string(letter) + `:\`
		if st, err := os.Stat(root); err == nil && st.IsDir() {
			out = append(out, FsEntry{Name: root, Path: root, Dir: true})
		}
	}
	if len(out) == 0 {
		out = append(out, FsEntry{Name: "/", Path: "/", Dir: true})
	}
	return out
}

func (c *Core) allowDownload(path string) bool {
	path = filepath.Clean(path)
	roots := []string{c.recordingsRoot(), c.savedRoot(), c.snapshotsRoot(), c.root}
	for _, r := range roots {
		absR, err1 := filepath.Abs(r)
		absP, err2 := filepath.Abs(path)
		if err1 != nil || err2 != nil {
			continue
		}
		rel, err := filepath.Rel(absR, absP)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

type bundle struct {
	Kind       string    `json:"kind"`
	Version    int       `json:"version"`
	ExportedAt string    `json:"exportedAt"`
	AppVersion string    `json:"appVersion,omitempty"`
	Channels   []Channel `json:"channels"`
	GroupOrder []string  `json:"groupOrder"`
	Settings   Settings  `json:"settings"`
	Layout     Layout    `json:"layout"`
}

func (c *Core) ExportConfig(path string, parts map[string]bool) (int, error) {
	if strings.TrimSpace(path) == "" {
		return 0, errStr("未选择保存路径")
	}
	b := c.makeBundle(parts)
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := writeFileAtomic(path, raw); err != nil {
		return 0, err
	}
	return len(b.Channels), nil
}

func (c *Core) makeBundle(parts map[string]bool) bundle {
	if parts == nil {
		parts = map[string]bool{"channels": true, "groupOrder": true, "settings": true, "layout": true}
	}
	b := bundle{Kind: "navora-monitor-config", Version: 1, ExportedAt: time.Now().UTC().Format(time.RFC3339), AppVersion: Version}
	if parts["channels"] {
		b.Channels = c.Channels()
	}
	if parts["groupOrder"] {
		b.GroupOrder = c.GroupOrder()
	}
	if parts["settings"] {
		s := c.Settings()
		s.RecordingsPath = ""
		s.SnapshotsPath = ""
		s.SavedClipsPath = ""
		s.RecordCachePath = ""
		s.FFmpegPath = ""
		s.RetentionDays = 0
		s.DiskWarnFreeGb = defaultSettings().DiskWarnFreeGb
		s.DiskStopFreeGb = defaultSettings().DiskStopFreeGb
		s.DiskAutoCleanup = true
		s.RecordCacheEnabled = true
		s.OpenAtLogin = false
		s.RemotePassword = ""
		b.Settings = s
	}
	if parts["layout"] {
		b.Layout = c.Layout()
	}
	if b.Channels == nil {
		b.Channels = []Channel{}
	}
	return b
}

type InspectResult struct {
	OK           bool            `json:"ok"`
	Path         string          `json:"path,omitempty"`
	Summary      string          `json:"summary,omitempty"`
	ExportedAt   string          `json:"exportedAt,omitempty"`
	Available    map[string]bool `json:"available,omitempty"`
	ChannelCount int             `json:"channelCount,omitempty"`
	Channels     []importCh      `json:"channels,omitempty"`
	Error        string          `json:"error,omitempty"`
	Canceled     bool            `json:"canceled,omitempty"`
}

type importCh struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Group string `json:"group"`
}

func (c *Core) InspectConfig(path string) InspectResult {
	b, err := os.ReadFile(path)
	if err != nil {
		return InspectResult{OK: false, Error: "无法读取配置文件"}
	}
	return c.inspectBytes(path, b)
}

func (c *Core) InspectUpload(name string, b []byte) (InspectResult, error) {
	if len(b) > 8<<20 {
		return InspectResult{}, errStr("配置文件过大")
	}
	dir := filepath.Join(c.root, "uploads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return InspectResult{}, err
	}
	path := filepath.Join(dir, time.Now().Format("20060102-150405")+"-"+sanitizeFileStem(name)+".json")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return InspectResult{}, err
	}
	return c.inspectBytes(path, b), nil
}

func (c *Core) inspectBytes(path string, b []byte) InspectResult {
	var doc bundle
	if json.Unmarshal(b, &doc) != nil || doc.Kind != "navora-monitor-config" {
		return InspectResult{OK: false, Error: "不是 Navora Monitor 配置文件"}
	}
	var chs []importCh
	for _, ch := range doc.Channels {
		chs = append(chs, importCh{ID: ch.ID, Name: ch.Name, Group: channelGroup(ch.Group)})
	}
	if chs == nil {
		chs = []importCh{}
	}
	avail := map[string]bool{
		"channels":   len(doc.Channels) > 0,
		"groupOrder": len(doc.GroupOrder) > 0,
		"settings":   doc.Settings.Version != 0 || doc.Settings.RemotePort != 0,
		"layout":     doc.Layout.Version != 0 || doc.Layout.Mosaic != 0,
	}
	summary := "配置包"
	if len(doc.Channels) > 0 {
		summary = strings.TrimSpace(strings.ReplaceAll(summary+" · "+itoa(len(doc.Channels))+" 路通道", "配置包 · ", ""))
		if !strings.Contains(summary, "路") {
			summary = itoa(len(doc.Channels)) + " 路通道"
		}
	}
	return InspectResult{
		OK: true, Path: path, Summary: summary, ExportedAt: doc.ExportedAt,
		Available: avail, ChannelCount: len(doc.Channels), Channels: chs,
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var d [16]byte
	i := len(d)
	for n > 0 {
		i--
		d[i] = byte('0' + n%10)
		n /= 10
	}
	return string(d[i:])
}

func (c *Core) ApplyConfig(path string, parts map[string]bool, keepLocal bool, channelIDs []string) (bundle, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return bundle{}, errStr("无法读取配置文件")
	}
	var doc bundle
	if json.Unmarshal(b, &doc) != nil || doc.Kind != "navora-monitor-config" {
		return bundle{}, errStr("不是 Navora Monitor 配置文件")
	}
	if parts == nil {
		parts = map[string]bool{"channels": true, "groupOrder": true, "settings": true, "layout": true}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if parts["channels"] {
		allow := map[string]bool{}
		if len(channelIDs) > 0 {
			for _, id := range channelIDs {
				allow[id] = true
			}
		}
		var next []Channel
		seen := map[string]bool{}
		for _, ch := range doc.Channels {
			if len(allow) > 0 && !allow[ch.ID] {
				continue
			}
			clean, ok := sanitizeChannel(ch)
			if !ok || seen[clean.ID] {
				continue
			}
			seen[clean.ID] = true
			next = append(next, clean)
		}
		c.channels = next
	}
	if parts["groupOrder"] {
		c.groupOrder = doc.GroupOrder
	}
	if parts["settings"] {
		incoming := sanitizeSettings(doc.Settings)
		if keepLocal {
			cur := c.settings
			incoming.RecordingsPath = cur.RecordingsPath
			incoming.SnapshotsPath = cur.SnapshotsPath
			incoming.SavedClipsPath = cur.SavedClipsPath
			incoming.RecordCachePath = cur.RecordCachePath
			incoming.FFmpegPath = cur.FFmpegPath
			incoming.RetentionDays = cur.RetentionDays
			incoming.DiskWarnFreeGb = cur.DiskWarnFreeGb
			incoming.DiskStopFreeGb = cur.DiskStopFreeGb
			incoming.DiskAutoCleanup = cur.DiskAutoCleanup
			incoming.RecordCacheEnabled = cur.RecordCacheEnabled
			incoming.OpenAtLogin = cur.OpenAtLogin
			incoming.RemotePassword = ""
			incoming.RemotePort = cur.RemotePort
			incoming.RemoteUsername = cur.RemoteUsername
		}
		incoming.RemotePassword = ""
		c.settings = incoming
		_ = c.saveSettingsLocked()
	}
	if err := c.saveChannelsLocked(); err != nil {
		return bundle{}, err
	}
	if parts["layout"] {
		c.mu.Unlock()
		_ = c.SetLayout(doc.Layout)
		c.mu.Lock()
	}
	out := bundle{
		Channels:   append([]Channel(nil), c.channels...),
		GroupOrder: c.listGroupsLocked(),
		Settings:   c.settings,
	}
	out.Settings.RemotePassword = ""
	c.mu.Unlock()
	out.Layout = c.Layout()
	c.mu.Lock()
	return out, nil
}

func (c *Core) Layout() Layout {
	b, err := os.ReadFile(filepath.Join(c.root, "layout.json"))
	if err != nil {
		return defaultLayout()
	}
	var l Layout
	if json.Unmarshal(b, &l) != nil {
		return defaultLayout()
	}
	return sanitizeLayout(l)
}

func (c *Core) SetLayout(l Layout) error {
	l = sanitizeLayout(l)
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(c.root, "layout.json"), b)
}

func defaultLayout() Layout {
	slots := make([]*string, 16)
	return Layout{
		Version:      1,
		PanelSizes:   panelSizes{Explorer: 240, Inspector: 280, Timeline: 112},
		ShowExplorer: true,
		ShowTimeline: true,
		Mosaic:       4,
		SlotIDs:      slots,
	}
}

func sanitizeLayout(l Layout) Layout {
	base := defaultLayout()
	if l.Mosaic != 1 && l.Mosaic != 4 && l.Mosaic != 9 && l.Mosaic != 16 {
		l.Mosaic = base.Mosaic
	}
	l.Version = 1
	l.PanelSizes.Explorer = clamp(l.PanelSizes.Explorer, 180, 420, 240)
	l.PanelSizes.Inspector = clamp(l.PanelSizes.Inspector, 220, 480, 280)
	l.PanelSizes.Timeline = clamp(l.PanelSizes.Timeline, 72, 320, 112)
	slots := make([]*string, 16)
	for i := 0; i < 16 && i < len(l.SlotIDs); i++ {
		if l.SlotIDs[i] != nil && strings.TrimSpace(*l.SlotIDs[i]) != "" {
			s := strings.TrimSpace(*l.SlotIDs[i])
			slots[i] = &s
		}
	}
	l.SlotIDs = slots
	return l
}

func clamp(n, min, max, def int) int {
	if n == 0 {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

func (c *Core) RepairConfig() (int, []string) {
	c.clearFFmpegCache()
	_ = os.MkdirAll(c.recordingsRoot(), 0o755)
	_ = os.MkdirAll(c.savedRoot(), 0o755)
	_ = os.MkdirAll(c.snapshotsRoot(), 0o755)
	c.mu.Lock()
	n := len(c.channels)
	err := c.saveChannelsLocked()
	_ = c.saveSettingsLocked()
	c.mu.Unlock()
	msgs := []string{"已整理通道与设置"}
	if err != nil {
		msgs = append(msgs, err.Error())
	}
	if c.ffmpegOK() {
		msgs = append(msgs, "FFmpeg 可用")
	} else {
		msgs = append(msgs, "未找到 FFmpeg")
	}
	previewRoot := filepath.Join(c.root, "preview")
	entries, _ := os.ReadDir(previewRoot)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, ok := c.prev.dir(e.Name()); ok {
			continue
		}
		_ = os.RemoveAll(filepath.Join(previewRoot, e.Name()))
	}
	msgs = append(msgs, "已清理空闲预览缓存")
	return n, msgs
}
