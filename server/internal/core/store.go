package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type Settings struct {
	Version               int     `json:"version"`
	RecordingsPath        string  `json:"recordingsPath"`
	SnapshotsPath         string  `json:"snapshotsPath"`
	DefaultSegmentTimeSec int     `json:"defaultSegmentTimeSec"`
	DefaultRtspTransport  string  `json:"defaultRtspTransport"`
	CloseToTray           bool    `json:"closeToTray"`
	ShowMainOnStartup     bool    `json:"showMainOnStartup"`
	RelaunchTrayWhenIdle  bool    `json:"relaunchTrayWhenIdle"`
	OpenAtLogin           bool    `json:"openAtLogin"`
	FFmpegPath            string  `json:"ffmpegPath"`
	RetentionDays         int     `json:"retentionDays"`
	DiskWarnFreeGb        float64 `json:"diskWarnFreeGb"`
	DiskStopFreeGb        float64 `json:"diskStopFreeGb"`
	DiskAutoCleanup       bool    `json:"diskAutoCleanup"`
	RecordCacheEnabled    bool    `json:"recordCacheEnabled"`
	RecordCachePath       string  `json:"recordCachePath"`
	SavedClipsPath        string  `json:"savedClipsPath"`
	SavedClipDurationSec  int     `json:"savedClipDurationSec"`
	UITheme               string  `json:"uiTheme"`
	RemoteEnabled         bool    `json:"remoteEnabled"`
	RemotePort            int     `json:"remotePort"`
	RemoteUsername        string  `json:"remoteUsername"`
	RemotePassword        string  `json:"remotePassword"`
	// PreviewTranscodeH264 forces live preview through libx264 so browsers
	// without HEVC MSE (Windows 10 Edge without the HEVC pack) can play.
	PreviewTranscodeH264 bool `json:"previewTranscodeH264"`
}

func defaultSettings() Settings {
	return Settings{
		Version:               1,
		DefaultSegmentTimeSec: 300,
		DefaultRtspTransport:  "tcp",
		CloseToTray:           true,
		ShowMainOnStartup:     true,
		RelaunchTrayWhenIdle:  true,
		DiskWarnFreeGb:        5,
		DiskStopFreeGb:        1,
		DiskAutoCleanup:       true,
		RecordCacheEnabled:    true,
		SavedClipDurationSec:  600,
		UITheme:               "system",
		RemotePort:            8780,
		RemoteUsername:        "navora",
	}
}

type Channel struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	URL            string    `json:"url"`
	Enabled        bool      `json:"enabled"`
	RtspTransport  string    `json:"rtspTransport,omitempty"`
	SegmentTimeSec int       `json:"segmentTimeSec,omitempty"`
	PreviewURL     string    `json:"previewUrl,omitempty"`
	Schedule       *schedule `json:"schedule,omitempty"`
	Group          string    `json:"group,omitempty"`
}

type channelsFile struct {
	Version    int       `json:"version"`
	Channels   []Channel `json:"channels"`
	GroupOrder []string  `json:"groupOrder"`
}

type authFile struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
}

type Layout struct {
	Version        int        `json:"version"`
	PanelSizes     panelSizes `json:"panelSizes"`
	ShowExplorer   bool       `json:"showExplorer"`
	ShowInspector  bool       `json:"showInspector"`
	ShowTimeline   bool       `json:"showTimeline"`
	Mosaic         int        `json:"mosaic"`
	FeaturedLayout bool       `json:"featuredLayout"`
	SlotIDs        []*string  `json:"slotIds"`
}

type panelSizes struct {
	Explorer  int `json:"explorer"`
	Inspector int `json:"inspector"`
	Timeline  int `json:"timeline"`
}

type Session struct {
	done     chan struct{}
	Username string
	Expires  time.Time
	// channel id -> last demand refresh
	Previews map[string]time.Time
}

type Core struct {
	scanMu     sync.Mutex
	scanCancel context.CancelFunc
	scanID     uint64
	mu         sync.Mutex
	root       string
	settings   Settings
	channels   []Channel
	groupOrder []string
	// Last committed channel document, used to restore every mutation on write failure.
	committedChannels []Channel
	committedGroups   []string
	auth              authFile
	sessions          map[string]*Session
	loginWindows      map[string]loginWindow
	accessChanged     chan struct{}
	events            *broker
	ws                *wsHub

	rec    *recorder
	prev   *previewMgr
	media  *mediaKit
	ingest *ingestMgr

	scheduleHold map[string]bool
	// Manual recordings to resume after process/service restart (persisted).
	remembered             map[string]bool
	listenPort             int
	listenURLs             []string
	remoteSwitch           func(bool) error
	listenAddress          func() string
	storageDefaultsChanged bool

	// Set when any browser reports HEVC MSE is unavailable.
	previewNeedH264 bool

	shutdownOnce sync.Once
	shutdownCh   chan struct{}
}

func Open(root string) (*Core, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	root = absRoot
	if windowsSystemPath(root) {
		return nil, fmt.Errorf("配置数据目录不能位于 Windows 系统目录，请通过 --data 指定独立数据目录")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	c := &Core{
		root:          root,
		sessions:      map[string]*Session{},
		accessChanged: make(chan struct{}),
		events:        newBroker(),
		ws:            newWSHub(),
		scheduleHold:  map[string]bool{},
		remembered:    map[string]bool{},
	}
	c.events.extra = func(event string, v any) {
		c.ws.broadcast(event, v)
	}
	if c.settings, err = c.loadSettings(); err != nil {
		return nil, fmt.Errorf("读取 settings.json 失败，请检查权限或恢复备份：%w", err)
	}
	if c.channels, c.groupOrder, err = c.loadChannels(); err != nil {
		return nil, fmt.Errorf("读取 channels.json 失败，请检查权限或恢复备份：%w", err)
	}
	c.committedChannels = append([]Channel(nil), c.channels...)
	c.committedGroups = append([]string(nil), c.groupOrder...)
	if c.auth, err = c.loadAuth(); err != nil {
		return nil, fmt.Errorf("读取 auth.json 失败，请检查权限或恢复备份：%w", err)
	}
	if c.storageDefaultsChanged {
		if err := c.saveSettingsLocked(); err != nil {
			return nil, fmt.Errorf("固定默认存储路径失败：%w", err)
		}
	}
	c.remembered = c.loadRemembered()
	c.rec = newRecorder(c)
	c.prev = newPreview(c)
	c.media = newMedia(c)
	c.initShutdown()
	// v1 defaults to a single input. The old pipeline remains an explicit
	// rollback for deployments whose camera compatibility is still being tested.
	if os.Getenv("NAVORA_MONITOR_SHARED_INGEST") != "0" {
		c.ingest = newIngest(c)
	}
	return c, nil
}

func (c *Core) Root() string { return c.root }

func (c *Core) Events() *broker { return c.events }

func (c *Core) loadSettings() (Settings, error) {
	s := defaultSettings()
	b, err := os.ReadFile(filepath.Join(c.root, "settings.json"))
	if err != nil {
		if os.IsNotExist(err) {
			for _, name := range []string{"auth.json", "channels.json"} {
				if _, statErr := os.Stat(filepath.Join(c.root, name)); statErr == nil {
					return s, fmt.Errorf("已有数据但 settings.json 缺失，请恢复配置备份；不会自动覆盖旧配置")
				}
			}
			if windowsSystemPath(c.root) {
				return s, fmt.Errorf("数据目录位于 Windows 系统目录，请通过 --data 指定独立数据目录")
			}
			c.storageDefaultsChanged = true
			return c.storageDefaults(s, false), nil
		}
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return s, err
	}
	s = sanitizeSettings(s)
	original := s
	if s.RecordingsPath == "" || s.SavedClipsPath == "" || s.SnapshotsPath == "" || s.RecordCachePath == "" {
		if windowsSystemPath(c.root) {
			return s, fmt.Errorf("默认存储路径位于 Windows 系统目录，请恢复或明确设置存储路径")
		}
		c.storageDefaultsChanged = true
	}
	s = c.storageDefaults(s, true)
	if s != original {
		c.storageDefaultsChanged = true
	}
	return s, nil
}

func sanitizeSettings(s Settings) Settings {
	base := defaultSettings()
	s.Version = 1
	s.RecordingsPath = strings.TrimSpace(s.RecordingsPath)
	s.SnapshotsPath = strings.TrimSpace(s.SnapshotsPath)
	s.RecordCachePath = strings.TrimSpace(s.RecordCachePath)
	s.SavedClipsPath = strings.TrimSpace(s.SavedClipsPath)
	s.FFmpegPath = strings.TrimSpace(s.FFmpegPath)
	if s.DefaultSegmentTimeSec < 10 {
		s.DefaultSegmentTimeSec = base.DefaultSegmentTimeSec
	}
	if s.DefaultRtspTransport != "udp" {
		s.DefaultRtspTransport = "tcp"
	}
	if s.RetentionDays < 0 {
		s.RetentionDays = 0
	}
	if s.DiskWarnFreeGb < 0 {
		s.DiskWarnFreeGb = base.DiskWarnFreeGb
	}
	if s.DiskStopFreeGb < 0 {
		s.DiskStopFreeGb = base.DiskStopFreeGb
	}
	if s.SavedClipDurationSec < 30 {
		s.SavedClipDurationSec = base.SavedClipDurationSec
	}
	if s.SavedClipDurationSec > 3600 {
		s.SavedClipDurationSec = 3600
	}
	if s.UITheme != "dark" && s.UITheme != "light" && s.UITheme != "system" {
		s.UITheme = base.UITheme
	}
	if s.RemotePort < 1024 || s.RemotePort > 65535 {
		s.RemotePort = base.RemotePort
	}
	s.RemoteUsername = sanitizeUsername(s.RemoteUsername)
	return s
}

func (c *Core) saveSettingsLocked() error {
	s := c.settings
	s.RemotePassword = ""
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(c.root, "settings.json"), b)
}

func (c *Core) loadAuth() (authFile, error) {
	var a authFile
	b, err := os.ReadFile(filepath.Join(c.root, "auth.json"))
	if os.IsNotExist(err) {
		return a, nil
	}
	if err != nil {
		return a, err
	}
	if err := json.Unmarshal(b, &a); err != nil {
		return a, err
	}
	return a, nil
}

func (c *Core) saveAuthLocked() error {
	b, err := json.MarshalIndent(c.auth, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(c.root, "auth.json"), b)
}

// EnsurePassword migrates a legacy plaintext password or creates a random one.
// created is true only when a new password was generated (caller should print it).
func (c *Core) EnsurePassword(reset bool) (password string, created bool, migrated bool, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if reset || c.auth.PasswordHash == "" {
		plain := strings.TrimSpace(c.settings.RemotePassword)
		if !reset && plain != "" {
			hash, herr := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
			if herr != nil {
				return "", false, false, herr
			}
			c.auth.PasswordHash = string(hash)
			c.auth.Username = c.settings.RemoteUsername
			c.settings.RemotePassword = ""
			if err = c.saveAuthLocked(); err != nil {
				return "", false, false, err
			}
			if err = c.saveSettingsLocked(); err != nil {
				return "", false, false, err
			}
			return "", false, true, nil
		}
		pw, gerr := generatePassword(16)
		if gerr != nil {
			return "", false, false, gerr
		}
		hash, herr := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
		if herr != nil {
			return "", false, false, herr
		}
		c.auth.PasswordHash = string(hash)
		c.auth.Username = c.settings.RemoteUsername
		c.settings.RemotePassword = ""
		if err = c.saveAuthLocked(); err != nil {
			return "", false, false, err
		}
		_ = c.saveSettingsLocked()
		return pw, true, false, nil
	}
	return "", false, false, nil
}

func (c *Core) CheckLogin(username, password string) bool {
	c.mu.Lock()
	user := c.settings.RemoteUsername
	hash := c.auth.PasswordHash
	c.mu.Unlock()
	if username != user || hash == "" {
		// Keep cost similar when the user is wrong.
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012"), []byte(password))
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

func (c *Core) SetPassword(password string) error {
	if strings.TrimSpace(password) == "" {
		return errors.New("密码不能为空")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.auth.PasswordHash = string(hash)
	c.auth.Username = c.settings.RemoteUsername
	c.settings.RemotePassword = ""
	if err = c.saveAuthLocked(); err != nil {
		return err
	}
	if err = c.saveSettingsLocked(); err != nil {
		return err
	}
	for token := range c.sessions {
		c.revokeSessionLocked(token)
	}
	return nil
}

func (c *Core) OpenSession(username string) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	c.mu.Lock()
	c.sessions[token] = &Session{
		done:     make(chan struct{}),
		Username: username,
		Expires:  time.Now().Add(12 * time.Hour),
		Previews: map[string]time.Time{},
	}
	c.mu.Unlock()
	return token, nil
}

func (c *Core) Session(token string) (*Session, bool) {
	if token == "" {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.sessions[token]
	if !ok || time.Now().After(s.Expires) {
		c.revokeSessionLocked(token)
		return nil, false
	}
	return s, true
}

func (c *Core) DropSession(token string) {
	c.mu.Lock()
	c.revokeSessionLocked(token)
	c.mu.Unlock()
	c.prev.reconcile()
}

func (c *Core) TouchPreviews(token string, ids []string) {
	now := time.Now()
	var removed []string
	c.mu.Lock()
	s, ok := c.sessions[token]
	if ok {
		s.Expires = time.Now().Add(12 * time.Hour)
		next := map[string]time.Time{}
		for _, id := range ids {
			if safeChannelID(id) {
				next[id] = now
			}
		}
		for id := range s.Previews {
			if _, keep := next[id]; !keep {
				removed = append(removed, id)
			}
		}
		s.Previews = next
	}
	c.mu.Unlock()
	if ok {
		c.prev.releaseWanted(removed)
		c.prev.reconcile()
	}
}

// AddPreviewWant marks a channel as wanted by this session (explicit start).
func (c *Core) AddPreviewWant(token, id string) {
	if token == "" || !safeChannelID(id) {
		return
	}
	c.mu.Lock()
	if s := c.sessions[token]; s != nil {
		if s.Previews == nil {
			s.Previews = map[string]time.Time{}
		}
		s.Previews[id] = time.Now()
		s.Expires = time.Now().Add(12 * time.Hour)
	}
	c.mu.Unlock()
}

// ClearPreviewWant drops a channel from every session's preview want-list
// so reconcile / heartbeat cannot revive it after an explicit stop.
func (c *Core) ClearPreviewWant(id string) {
	if !safeChannelID(id) {
		return
	}
	c.mu.Lock()
	for _, s := range c.sessions {
		delete(s.Previews, id)
	}
	c.mu.Unlock()
}

func (c *Core) gcSessions() {
	now := time.Now()
	c.mu.Lock()
	for k, s := range c.sessions {
		if now.After(s.Expires) {
			c.revokeSessionLocked(k)
		}
	}
	c.mu.Unlock()
}

func (c *Core) wantedPreviews() map[string]bool {
	now := time.Now()
	out := map[string]bool{}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, s := range c.sessions {
		for id, at := range s.Previews {
			if now.Sub(at) < 25*time.Second {
				out[id] = true
			}
		}
	}
	return out
}

type configWriteLock struct {
	sync.Mutex
	users int
}

var configWrites = struct {
	sync.Mutex
	paths map[string]*configWriteLock
}{paths: map[string]*configWriteLock{}}

func lockConfigWrite(path string) func() {
	key := leaseKey(path)
	configWrites.Lock()
	lock := configWrites.paths[key]
	if lock == nil {
		lock = &configWriteLock{}
		configWrites.paths[key] = lock
	}
	lock.users++
	configWrites.Unlock()
	lock.Lock()
	return func() {
		lock.Unlock()
		configWrites.Lock()
		lock.users--
		if lock.users == 0 {
			delete(configWrites.paths, key)
		}
		configWrites.Unlock()
	}
}

func writeFileAtomic(path string, b []byte) error {
	unlock := lockConfigWrite(path)
	defer unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".navora-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err := file.Write(b); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return replaceFile(file.Name(), path)
}

func (c *Core) loadChannels() ([]Channel, []string, error) {
	var f channelsFile
	b, err := os.ReadFile(filepath.Join(c.root, "channels.json"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, nil, err
	}
	var list []Channel
	seen := map[string]bool{}
	for _, ch := range f.Channels {
		clean, ok := sanitizeChannel(ch)
		if !ok || seen[clean.ID] {
			continue
		}
		seen[clean.ID] = true
		list = append(list, clean)
	}
	return list, f.GroupOrder, nil
}

func sanitizeChannel(ch Channel) (Channel, bool) {
	ch.ID = strings.TrimSpace(ch.ID)
	ch.URL = strings.TrimSpace(ch.URL)
	if ch.ID == "" || ch.URL == "" || !safeChannelID(ch.ID) {
		return Channel{}, false
	}
	if strings.TrimSpace(ch.Name) == "" {
		ch.Name = ch.ID
	} else {
		ch.Name = strings.TrimSpace(ch.Name)
	}
	if ch.RtspTransport != "udp" {
		ch.RtspTransport = "tcp"
	}
	if ch.SegmentTimeSec < 10 {
		ch.SegmentTimeSec = 300
	}
	ch.PreviewURL = strings.TrimSpace(ch.PreviewURL)
	ch.Group = storedGroupValue(ch.Group)
	if ch.Schedule != nil {
		if !ch.Schedule.Enabled || len(ch.Schedule.Days) == 0 {
			ch.Schedule = nil
		} else {
			if _, ok := parseHm(ch.Schedule.Start); !ok {
				ch.Schedule.Start = "00:00"
			}
			if _, ok := parseHm(ch.Schedule.End); !ok {
				ch.Schedule.End = "23:59"
			}
			seen := map[int]bool{}
			var days []int
			for _, d := range ch.Schedule.Days {
				if d < 0 || d > 6 || seen[d] {
					continue
				}
				seen[d] = true
				days = append(days, d)
			}
			if len(days) == 0 {
				ch.Schedule = nil
			} else {
				ch.Schedule.Days = days
				ch.Schedule.Enabled = true
			}
		}
	}
	return ch, true
}

func (c *Core) saveChannelsLocked() (err error) {
	defer func() {
		if err != nil {
			c.channels = append([]Channel(nil), c.committedChannels...)
			c.groupOrder = append([]string(nil), c.committedGroups...)
		} else {
			c.committedChannels = append([]Channel(nil), c.channels...)
			c.committedGroups = append([]string(nil), c.groupOrder...)
		}
	}()
	f := channelsFile{Version: 1, Channels: c.channels, GroupOrder: c.groupOrder}
	if f.Channels == nil {
		f.Channels = []Channel{}
	}
	if f.GroupOrder == nil {
		f.GroupOrder = []string{}
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(c.root, "channels.json"), b)
}

func (c *Core) Channels() []Channel {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Channel, len(c.channels))
	copy(out, c.channels)
	return out
}

func (c *Core) channelByID(id string) (Channel, bool) {
	for _, ch := range c.channels {
		if ch.ID == id {
			return ch, true
		}
	}
	return Channel{}, false
}

func (c *Core) Settings() Settings {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.settings
	s.RemotePassword = ""
	return s
}

func (c *Core) UpdateSettings(next Settings) (Settings, error) {
	// Serialize storage changes with recorder start/stop so an active FFmpeg
	// process cannot keep writing to a directory hidden by the new settings.
	if c.rec != nil {
		c.rec.opMu.Lock()
		defer c.rec.opMu.Unlock()
	}
	return c.updateSettingsLocked(next)
}

func (c *Core) updateSettingsLocked(next Settings) (Settings, error) {
	pw := strings.TrimSpace(next.RemotePassword)
	c.mu.Lock()
	prev := c.settings
	next = sanitizeSettings(next)
	next.RemotePassword = ""
	next = c.storageDefaults(next, false)
	storageChanged := !samePath(next.RecordingsPath, prev.RecordingsPath) ||
		!samePath(next.RecordCachePath, prev.RecordCachePath) || next.RecordCacheEnabled != prev.RecordCacheEnabled
	if storageChanged && c.rec != nil {
		for _, channel := range c.channels {
			if c.rec.running(channel.ID) {
				c.mu.Unlock()
				return Settings{}, fmt.Errorf("请先停止录像，再修改录像目录、缓存目录或缓存开关；不会中断正在进行的录像")
			}
		}
	}
	for _, item := range []struct{ next, prev string }{
		{next.RecordingsPath, prev.RecordingsPath}, {next.SavedClipsPath, prev.SavedClipsPath},
		{next.SnapshotsPath, prev.SnapshotsPath}, {next.RecordCachePath, prev.RecordCachePath},
	} {
		if item.next != "" && !samePath(item.next, item.prev) && windowsSystemPath(item.next) {
			c.mu.Unlock()
			return Settings{}, fmt.Errorf("存储目录不能位于 Windows 系统目录，请选择独立录像目录")
		}
	}
	remoteChanged := prev.RemoteEnabled != next.RemoteEnabled
	if remoteChanged && c.remoteSwitch != nil {
		if err := c.remoteSwitch(next.RemoteEnabled); err != nil {
			c.mu.Unlock()
			return Settings{}, fmt.Errorf("切换局域网监听失败，设置未保存：%w", err)
		}
	}
	// Hidden Electron-era flags stay as previously stored if the client omitted them
	// by sending the Go zero value only when the JSON included them. The Vue client
	// always sends the full object, so keep the incoming values.
	if next.FFmpegPath != prev.FFmpegPath {
		c.clearFFmpegCache()
	}
	c.settings = next
	err := c.saveSettingsLocked()
	if err != nil {
		c.settings = prev
		if remoteChanged && c.remoteSwitch != nil {
			if rollbackErr := c.remoteSwitch(prev.RemoteEnabled); rollbackErr != nil {
				err = fmt.Errorf("%w；恢复监听失败：%v，请重启服务", err, rollbackErr)
			}
		}
	} else {
		if prev.RemoteEnabled != next.RemoteEnabled {
			close(c.accessChanged)
			c.accessChanged = make(chan struct{})
		}
		if prev.RemoteUsername != next.RemoteUsername {
			for token := range c.sessions {
				c.revokeSessionLocked(token)
			}
		}
	}
	s := c.settings
	needRestart := prev.PreviewTranscodeH264 != next.PreviewTranscodeH264
	c.mu.Unlock()
	if err != nil {
		return Settings{}, err
	}
	if needRestart {
		c.prev.restartCodecMismatch()
	}
	if pw != "" {
		if err = c.SetPassword(pw); err != nil {
			return Settings{}, err
		}
	}
	s.RemotePassword = ""
	return s, nil
}

func (c *Core) UpsertChannel(ch Channel) ([]Channel, error) {
	return c.UpsertChannels([]Channel{ch})
}

func (c *Core) UpsertChannels(list []Channel) ([]Channel, error) {
	cleanList := make([]Channel, 0, len(list))
	seen := map[string]bool{}
	for _, ch := range list {
		clean, ok := sanitizeChannel(ch)
		if !ok || seen[clean.ID] {
			return nil, errors.New("无效或重复的通道配置")
		}
		seen[clean.ID] = true
		cleanList = append(cleanList, clean)
	}
	c.rec.opMu.Lock()
	defer c.rec.opMu.Unlock()
	c.mu.Lock()
	previous := append([]Channel(nil), c.channels...)
	for _, clean := range cleanList {
		found := false
		for i := range c.channels {
			if c.channels[i].ID == clean.ID {
				c.channels[i] = clean
				found = true
				break
			}
		}
		if !found {
			c.channels = append(c.channels, clean)
		}
		g := channelGroup(clean.Group)
		if g != defaultGroup && !contains(c.groupOrder, g) {
			c.groupOrder = append(c.groupOrder, g)
		}
	}
	if err := c.saveChannelsLocked(); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	out := append([]Channel(nil), c.channels...)
	c.mu.Unlock()
	if err := c.reconcileChannelChangesLocked(previous, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Core) RemoveChannels(ids []string) ([]Channel, error) {
	c.rec.opMu.Lock()
	defer c.rec.opMu.Unlock()
	drop := map[string]bool{}
	for _, id := range ids {
		drop[id] = true
	}
	c.mu.Lock()
	var next []Channel
	for _, ch := range c.channels {
		if !drop[ch.ID] {
			next = append(next, ch)
		}
	}
	c.channels = next
	if err := c.saveChannelsLocked(); err != nil {
		c.mu.Unlock()
		return nil, err
	}
	out := append([]Channel(nil), c.channels...)
	changed := false
	for _, id := range ids {
		if c.remembered[id] {
			delete(c.remembered, id)
			changed = true
		}
	}
	if changed {
		c.saveRememberedLocked()
	}
	c.mu.Unlock()
	for _, id := range ids {
		c.rec.stopLocked(id)
		c.ClearPreviewWant(id)
		c.prev.stop(id)
	}
	return out, nil
}

func contains(ss []string, v string) bool {
	for _, s := range ss {
		if s == v {
			return true
		}
	}
	return false
}
