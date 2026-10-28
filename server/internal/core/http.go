package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const cookieName = "nm_session"

func (c *Core) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", c.route)
	return mux
}

func (c *Core) route(w http.ResponseWriter, r *http.Request) {
	if !c.Settings().RemoteEnabled && !loopbackRequest(r.RemoteAddr) {
		http.Error(w, "远程访问已关闭", http.StatusForbidden)
		return
	}
	if r.URL.Path == "/api/login" && r.Method == http.MethodPost {
		c.handleLogin(w, r)
		return
	}
	if r.URL.Path == "/api/status" && r.Method == http.MethodGet {
		writeJSON(w, 200, c.publicStatus())
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/media/") {
		session, ok := c.authRequest(r)
		if !ok {
			writeJSON(w, 401, map[string]any{"ok": false, "error": "未登录"})
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		r = r.WithContext(ctx)
		c.mu.Lock()
		accessChanged := c.accessChanged
		c.mu.Unlock()
		go func() {
			for {
				select {
				case <-session.done:
					if strings.HasPrefix(r.URL.Path, "/media/") || r.URL.Path == "/api/events" || r.URL.Path == "/api/ws" {
						cancel()
						_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
					}
					return
				case <-accessChanged:
					if !loopbackRequest(r.RemoteAddr) && !c.Settings().RemoteEnabled {
						cancel()
						if strings.HasPrefix(r.URL.Path, "/media/") || r.URL.Path == "/api/events" || r.URL.Path == "/api/ws" {
							_ = http.NewResponseController(w).SetWriteDeadline(time.Now())
						}
						return
					}
					c.mu.Lock()
					accessChanged = c.accessChanged
					c.mu.Unlock()
				case <-ctx.Done():
					return
				}
			}
		}()

	}
	switch {
	case r.URL.Path == "/api/logout" && r.Method == http.MethodPost:
		c.handleLogout(w, r)
	case r.URL.Path == "/api/shutdown" && r.Method == http.MethodPost:
		writeJSON(w, 200, map[string]any{"ok": true, "message": "正在退出"})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go c.RequestShutdown()
	case r.URL.Path == "/api/system-service" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.SystemServiceStatus())
	case r.URL.Path == "/api/system-service" && r.Method == http.MethodPost:
		var body struct {
			Action string `json:"action"`
		}
		if err := readJSON(r, &body); err != nil || body.Action == "" {
			writeJSON(w, 400, map[string]string{"error": "无效请求"})
			return
		}
		// Always 200: callers read info.error / info.message for outcome.
		writeJSON(w, 200, c.SystemServiceAction(body.Action))
	case r.URL.Path == "/api/session" && r.Method == http.MethodGet:
		s, _ := c.authRequest(r)
		writeJSON(w, 200, map[string]any{"ok": true, "username": s.Username})
	case r.URL.Path == "/api/events" && r.Method == http.MethodGet:
		c.handleEvents(w, r)
	case r.URL.Path == "/api/ws" && r.Method == http.MethodGet:
		c.handleWS(w, r)
	case r.URL.Path == "/api/app-info" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.appInfo())
	case r.URL.Path == "/api/settings" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.Settings())
	case r.URL.Path == "/api/settings" && r.Method == http.MethodPut:
		c.handlePutSettings(w, r)
	case r.URL.Path == "/api/disk" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.Disk())
	case r.URL.Path == "/api/storage/cleanup" && r.Method == http.MethodPost:
		writeJSON(w, 200, c.RunCleanup())
	case r.URL.Path == "/api/storage/clear-loop" && r.Method == http.MethodPost:
		writeJSON(w, 200, c.ClearLoop())
	case r.URL.Path == "/api/repair/config" && r.Method == http.MethodPost:
		n, msgs := c.RepairConfig()
		writeJSON(w, 200, map[string]any{"ok": true, "messages": msgs, "channelCount": n})
	case r.URL.Path == "/api/repair/timestamps" && r.Method == http.MethodPost:
		var body struct {
			ChannelID string `json:"channelId"`
			Force     bool   `json:"force"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		writeJSON(w, 200, c.RepairTimestamps(body.ChannelID, body.Force))
	case r.URL.Path == "/api/config/export" && r.Method == http.MethodPost:
		c.handleExport(w, r)
	case r.URL.Path == "/api/config/inspect" && r.Method == http.MethodPost:
		c.handleInspect(w, r)
	case r.URL.Path == "/api/config/upload" && r.Method == http.MethodPost:
		c.handleUploadConfig(w, r)
	case r.URL.Path == "/api/config/apply" && r.Method == http.MethodPost:
		c.handleApply(w, r)
	case r.URL.Path == "/api/fs/list" && r.Method == http.MethodGet:
		entries, path, err := c.ListFS(r.URL.Query().Get("path"), r.URL.Query().Get("mode"))
		if err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		if entries == nil {
			entries = []FsEntry{}
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": path, "entries": entries})
	case r.URL.Path == "/api/fs/download" && r.Method == http.MethodGet:
		c.handleDownload(w, r)
	case r.URL.Path == "/api/channels" && r.Method == http.MethodGet:
		list := c.Channels()
		if list == nil {
			list = []Channel{}
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/channels/upsert" && r.Method == http.MethodPost:
		var body struct {
			Channel Channel `json:"channel"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]string{"error": "无效请求"})
			return
		}
		list, err := c.UpsertChannel(body.Channel)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/channels/upsert-many" && r.Method == http.MethodPost:
		var body struct {
			Channels []Channel `json:"channels"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.UpsertChannels(body.Channels)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/channels/remove" && r.Method == http.MethodPost:
		var body struct {
			IDs []string `json:"ids"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.RemoveChannels(body.IDs)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/channels/move-group" && r.Method == http.MethodPost:
		var body struct {
			IDs   []string `json:"ids"`
			Group *string  `json:"group"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		g := ""
		if body.Group != nil {
			g = *body.Group
		}
		list, err := c.MoveChannelsBefore(body.IDs, g, nil)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/channels/move-before" && r.Method == http.MethodPost:
		var body struct {
			IDs         []string `json:"ids"`
			TargetGroup string   `json:"targetGroup"`
			BeforeID    *string  `json:"beforeId"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.MoveChannelsBefore(body.IDs, body.TargetGroup, body.BeforeID)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/groups" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.GroupOrder())
	case r.URL.Path == "/api/groups/move" && r.Method == http.MethodPost:
		var body struct {
			Group  string  `json:"group"`
			Before *string `json:"before"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.MoveGroupBefore(body.Group, body.Before)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/groups/create" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.CreateGroup(body.Name)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/groups/delete" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.DeleteGroup(body.Name)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/groups/rename" && r.Method == http.MethodPost:
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.RenameGroup(body.From, body.To)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/groups/dissolve" && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		list, err := c.DissolveGroup(body.Name)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/states" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.States())
	case r.URL.Path == "/api/record/start" && r.Method == http.MethodPost:
		c.handleRecordStart(w, r)
	case r.URL.Path == "/api/record/stop" && r.Method == http.MethodPost:
		c.handleRecordStop(w, r)
	case r.URL.Path == "/api/record/stop-all" && r.Method == http.MethodPost:
		for _, ch := range c.Channels() {
			_ = c.StopRecord(ch.ID, true)
		}
		writeJSON(w, 200, c.States())
	case r.URL.Path == "/api/record/group/start" && r.Method == http.MethodPost:
		c.handleGroupRecord(w, r, true)
	case r.URL.Path == "/api/record/group/stop" && r.Method == http.MethodPost:
		c.handleGroupRecord(w, r, false)
	case r.URL.Path == "/api/preview/start" && r.Method == http.MethodPost:
		var body struct {
			ID string `json:"id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		if err := c.prev.start(body.ID); err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		c.AddPreviewWant(cookieToken(r), body.ID)
		writeJSON(w, 200, map[string]any{"ok": true, "state": c.stateByID(body.ID)})
	case r.URL.Path == "/api/preview/stop" && r.Method == http.MethodPost:
		var body struct {
			ID string `json:"id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		c.ClearPreviewWant(body.ID)
		c.prev.stop(body.ID)
		writeJSON(w, 200, c.stateByID(body.ID))
	case r.URL.Path == "/api/client-caps" && r.Method == http.MethodPost:
		var caps struct {
			HevcMse *bool `json:"hevcMse"`
		}
		if err := readJSON(r, &caps); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		if caps.HevcMse != nil && !*caps.HevcMse {
			c.NoteNeedPreviewH264()
		}
		writeJSON(w, 200, map[string]any{"ok": true, "previewTranscodeH264": c.previewH264()})
	case r.URL.Path == "/api/previews" && r.Method == http.MethodPost:
		s, _ := c.authRequest(r)
		var body struct {
			ChannelIDs []string `json:"channelIds"`
			HevcMse    *bool    `json:"hevcMse"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		if len(body.ChannelIDs) > 16 {
			body.ChannelIDs = body.ChannelIDs[:16]
		}
		token := cookieToken(r)
		_ = s
		c.TouchPreviews(token, body.ChannelIDs)
		if body.HevcMse != nil && !*body.HevcMse {
			c.NoteNeedPreviewH264()
		}
		writeJSON(w, 200, c.States())
	case r.URL.Path == "/api/recordings" && r.Method == http.MethodGet:
		list := c.ListRecordings(r.URL.Query().Get("channelId"))
		if list == nil {
			list = []Segment{}
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/saved-clips" && r.Method == http.MethodGet:
		list := c.ListSaved(r.URL.Query().Get("channelId"))
		if list == nil {
			list = []Segment{}
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/playback/prepare" && r.Method == http.MethodPost:
		c.handlePrepare(w, r)
	case r.URL.Path == "/api/clips/save-recent" && r.Method == http.MethodPost:
		c.handleSaveRecent(w, r)
	case r.URL.Path == "/api/clips/export" && r.Method == http.MethodPost:
		c.handleExportClip(w, r)
	case r.URL.Path == "/api/clips/delete" && r.Method == http.MethodPost:
		var body struct {
			ID string `json:"id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		if err := c.DeleteSaved(body.ID); err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	case r.URL.Path == "/api/probe" && r.Method == http.MethodPost:
		var body struct {
			ID string `json:"id"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		ok, ms, msg := c.ProbeContext(r.Context(), body.ID)
		if ok {
			writeJSON(w, 200, map[string]any{"ok": true, "latencyMs": ms, "summary": msg})
		} else {
			writeJSON(w, 200, map[string]any{"ok": false, "latencyMs": ms, "error": msg})
		}
	case r.URL.Path == "/api/scan" && r.Method == http.MethodPost:
		c.handleScan(w, r)
	case r.URL.Path == "/api/scan/cancel" && r.Method == http.MethodPost:
		c.CancelScan()
		writeJSON(w, 200, map[string]any{"ok": true})
	case r.URL.Path == "/api/scan/subnets" && r.Method == http.MethodGet:
		list := c.Subnets()
		if list == nil {
			list = []Subnet{}
		}
		writeJSON(w, 200, list)
	case r.URL.Path == "/api/snapshots" && r.Method == http.MethodPost:
		var body struct {
			ChannelID string `json:"channelId"`
			DataURL   string `json:"dataUrl"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
			return
		}
		path, err := c.SaveSnapshot(body.ChannelID, body.DataURL)
		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": path})
	case r.URL.Path == "/api/layout" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.Layout())
	case r.URL.Path == "/api/layout" && r.Method == http.MethodPut:
		var l Layout
		if err := readJSON(r, &l); err != nil {
			writeJSON(w, 400, map[string]string{"error": "无效布局"})
			return
		}
		if err := c.SetLayout(l); err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, c.Layout())
	case r.URL.Path == "/api/remote/status" && r.Method == http.MethodGet:
		writeJSON(w, 200, c.remoteStatus())
	case r.URL.Path == "/api/remote/generate-password" && r.Method == http.MethodPost:
		pw, err := generatePassword(16)
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"password": pw})
	case strings.HasPrefix(r.URL.Path, "/media/"):
		c.handleMedia(w, r)
	default:
		c.handleStatic(w, r)
	}
}

func (c *Core) authRequest(r *http.Request) (*Session, bool) {
	return c.Session(cookieToken(r))
}

func cookieToken(r *http.Request) string {
	ck, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return ck.Value
}

func (c *Core) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !c.allowLogin(r.RemoteAddr) {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]any{"ok": false, "error": "登录尝试过于频繁，请一分钟后重试"})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	if !c.CheckLogin(strings.TrimSpace(body.Username), body.Password) {
		writeJSON(w, 401, map[string]any{"ok": false, "error": "账户或密码错误"})
		return
	}
	token, err := c.OpenSession(c.Settings().RemoteUsername)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": "无法创建会话"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((12 * time.Hour).Seconds()),
	})
	writeJSON(w, 200, map[string]any{"ok": true, "username": c.Settings().RemoteUsername})
}

func (c *Core) handleLogout(w http.ResponseWriter, r *http.Request) {
	c.DropSession(cookieToken(r))
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", HttpOnly: true, MaxAge: -1})
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (c *Core) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	ch := c.events.subscribe()
	defer c.events.unsubscribe(ch)
	_, _ = io.WriteString(w, ": ok\n\n")
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if _, err := w.Write(msg); err != nil {
				return
			}
			fl.Flush()
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func (c *Core) publicStatus() map[string]any {
	s := c.Settings()
	return map[string]any{
		"name":     "Navora Monitor",
		"version":  Version,
		"username": s.RemoteUsername,
	}
}

func (c *Core) appInfo() map[string]any {
	s := c.Settings()
	ff := c.ffmpegPath()
	cache := c.cacheRoot()
	storageWarning := ""
	for _, p := range []string{c.recordingsRoot(), c.savedRoot(), c.snapshotsRoot(), cache} {
		if p != "" && windowsSystemPath(p) {
			storageWarning = "旧存储目录位于 Windows 系统目录，请在设置中选择独立录像盘；已有文件未移动。"
		}
	}
	return map[string]any{
		"storageWarning":        storageWarning,
		"name":                  "Navora Monitor",
		"version":               Version,
		"license":               "MIT",
		"copyright":             "Copyright © 2026 Navora",
		"homepage":              "https://github.com/navora-harness/navora-monitor",
		"licenseNote":           "本软件源代码采用 MIT License。发行包内置的 FFmpeg 二进制遵循 GPLv3，分发时请一并遵守其许可义务。",
		"dataRoot":              c.root,
		"recordingsPath":        c.recordingsRoot(),
		"snapshotsPath":         c.snapshotsRoot(),
		"savedClipsPath":        c.savedRoot(),
		"recordCachePath":       cache,
		"recordCacheActive":     cache != "",
		"ffmpegPath":            nilIfEmpty(ff),
		"ffmpegOk":              c.ffmpegOK(),
		"mediaBaseUrl":          "",
		"defaultSegmentTimeSec": s.DefaultSegmentTimeSec,
		"savedClipDurationSec":  s.SavedClipDurationSec,
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (c *Core) remoteStatus() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.settings
	urls := []string{}
	if s.RemoteEnabled {
		urls = c.listenURLs
	}
	address := ""
	var listenError any
	if c.listenAddress != nil {
		address = c.listenAddress()
		host, _, _ := net.SplitHostPort(address)
		if s.RemoteEnabled && net.ParseIP(host).IsLoopback() {
			urls = []string{}
			listenError = "启动参数 --addr 限定了本机监听，请修改启动参数后重启服务"
		}
	}
	return map[string]any{
		"address":   address,
		"enabled":   s.RemoteEnabled,
		"listening": true,
		"port":      c.listenPort,
		"urls":      urls,
		"username":  s.RemoteUsername,
		"error":     listenError,
	}
}

func (c *Core) SetListen(port int, urls []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listenPort = port
	c.listenURLs = urls
}

func (c *Core) SetRemoteSwitch(switcher func(bool) error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remoteSwitch = switcher
}

func (c *Core) SetListenAddress(provider func() string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.listenAddress = provider
}

func (c *Core) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var s Settings
	if err := readJSON(r, &s); err != nil {
		writeJSON(w, 400, map[string]string{"error": "无效设置"})
		return
	}
	next, err := c.UpdateSettingsAndResume(s)
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, 200, next)
}

func (c *Core) handleExport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path  string          `json:"path"`
		Parts map[string]bool `json:"parts"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	n, err := c.ExportConfig(body.Path, body.Parts)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path, "channelCount": n, "parts": body.Parts})
}

func (c *Core) handleInspect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	writeJSON(w, 200, c.InspectConfig(body.Path))
}

func (c *Core) handleUploadConfig(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无法读取上传"})
		return
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "缺少文件"})
		return
	}
	defer f.Close()
	b, err := io.ReadAll(f)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "读取失败"})
		return
	}
	res, err := c.InspectUpload(hdr.Filename, b)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, res)
}

func (c *Core) handleApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path           string          `json:"path"`
		Parts          map[string]bool `json:"parts"`
		KeepLocalPaths bool            `json:"keepLocalPaths"`
		ChannelIDs     []string        `json:"channelIds"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	doc, err := c.ApplyConfig(body.Path, body.Parts, body.KeepLocalPaths, body.ChannelIDs)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "path": body.Path, "channelCount": len(doc.Channels),
		"keptLocalPaths": body.KeepLocalPaths, "parts": body.Parts,
		"channels": doc.Channels, "groupOrder": doc.GroupOrder,
		"settings": doc.Settings, "layout": doc.Layout,
	})
}

func (c *Core) handleDownload(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" || !c.allowDownload(path) {
		http.Error(w, "forbidden", 403)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(path)+"\"")
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (c *Core) handleRecordStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	st, err := c.StartRecord(body.ID, "manual")
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error(), "state": c.stateByID(body.ID)})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "state": st})
}

func (c *Core) handleRecordStop(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	if err := c.StopRecord(body.ID, true); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "state": c.stateByID(body.ID)})
}

func (c *Core) handleGroupRecord(w http.ResponseWriter, r *http.Request, start bool) {
	var body struct {
		Group *string `json:"group"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	if body.Group == nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "缺少分组"})
		return
	}
	name := normalizeGroupName(*body.Group)
	var errors []string
	started := 0
	total := 0
	for _, ch := range c.Channels() {
		if channelGroup(ch.Group) != name {
			continue
		}
		total++
		if start {
			if _, err := c.StartRecord(ch.ID, "manual"); err != nil {
				errors = append(errors, ch.Name+": "+err.Error())
			} else {
				started++
			}
		} else {
			_ = c.StopRecord(ch.ID, true)
			started++
		}
	}
	if errors == nil {
		errors = []string{}
	}
	if start {
		writeJSON(w, 200, map[string]any{"ok": len(errors) == 0, "started": started, "total": total, "errors": errors, "states": c.States()})
		return
	}
	writeJSON(w, 200, c.States())
}

func (c *Core) stateByID(id string) runtimeState {
	for _, s := range c.States() {
		if s.ID == id {
			return s
		}
	}
	return runtimeState{ID: id, Recording: "idle", Preview: "idle"}
}

func (c *Core) handlePrepare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Prefetch  bool   `json:"prefetch"`
		H264      bool   `json:"h264"`
		ChannelID string `json:"channelId"`
		FileName  string `json:"fileName"`
		Kind      string `json:"kind"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	kind := body.Kind
	if kind == "" {
		kind = "recordings"
	}
	path, err := c.prepareSharedCodec(r.Context(), kind, body.ChannelID, body.FileName, body.Prefetch, body.H264)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	url := "/media/play/" + kind + "/" + body.ChannelID + "/" + body.FileName
	if samePath(filepath.Dir(path), c.playCacheDir()) {
		url = "/media/cache/" + filepath.Base(path)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "url": url, "fileName": filepath.Base(path), "cached": true})
}

func (c *Core) handleSaveRecent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChannelID   string `json:"channelId"`
		DurationSec int    `json:"durationSec"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	n, msg, clips, err := c.SaveRecent(body.ChannelID, body.DurationSec)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if clips == nil {
		clips = []Segment{}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "copied": n, "durationSec": body.DurationSec, "message": msg, "clips": clips})
}

func (c *Core) handleExportClip(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChannelID string `json:"channelId"`
		StartMs   int64  `json:"startMs"`
		EndMs     int64  `json:"endMs"`
		DestPath  string `json:"destPath"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	path, n, err := c.ExportRangeContext(r.Context(), body.ChannelID, body.StartMs, body.EndMs, body.DestPath)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "path": path, "fileName": filepath.Base(path), "channelId": body.ChannelID,
		"startMs": body.StartMs, "endMs": body.EndMs, "segmentCount": n, "message": "已导出 " + filepath.Base(path),
	})
}

func (c *Core) handleScan(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode              string `json:"mode"`
		CIDR              string `json:"cidr"`
		Username          string `json:"username"`
		Password          string `json:"password"`
		PreferredPresetID string `json:"preferredPresetId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "无效请求"})
		return
	}
	start := time.Now()
	cams, hosts, err := c.ScanContext(r.Context(), body.Mode, body.CIDR, body.Username, body.Password, body.PreferredPresetID)
	if errors.Is(err, context.Canceled) {
		writeJSON(w, 200, map[string]any{"ok": false, "canceled": true})
		return
	}
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if cams == nil {
		cams = []Camera{}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "cameras": cams, "durationMs": time.Since(start).Milliseconds(), "scannedHosts": hosts})
}

func (c *Core) handleMedia(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/media/")
	parts := strings.Split(rest, "/")
	w.Header().Set("Cache-Control", "no-store")
	if len(parts) == 2 && parts[0] == "cache" && filepath.Base(parts[1]) == parts[1] && !strings.Contains(parts[1], "..") && strings.HasSuffix(parts[1], ".mp4") && !strings.HasPrefix(parts[1], ".") {
		p := filepath.Join(c.playCacheDir(), parts[1])
		release, err := c.media.leases.acquireContext(r.Context(), p)
		if err != nil {
			http.Error(w, "读取已取消", http.StatusRequestTimeout)
			return
		}
		defer release()
		serveFile(w, r, p)
		return
	}
	if len(parts) >= 3 && parts[0] == "live" {
		name := strings.Join(parts[2:], "/")
		if name == "live.ts" {
			c.prev.serveStream(w, r, parts[1])
			return
		}
		c.serveLive(w, r, parts[1], name)
		return
	}
	if len(parts) >= 3 && parts[0] == "preview" && parts[2] == "live.ts" {
		c.prev.serveStream(w, r, parts[1])
		return
	}
	if len(parts) >= 4 && parts[0] == "files" {
		p, err := c.resolveMedia(parts[1], parts[2], parts[3])
		if err != nil {
			http.NotFound(w, r)
			return
		}
		release, err := c.media.leases.acquireContext(r.Context(), p)
		if err != nil {
			http.Error(w, "读取已取消", http.StatusRequestTimeout)
			return
		}
		defer release()
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filepath.Base(p)}))
		}
		serveFile(w, r, p)
		return
	}
	if len(parts) >= 4 && parts[0] == "play" {
		p, err := c.EnsurePlayableContext(r.Context(), parts[1], parts[2], parts[3])
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		release, err := c.media.leases.acquireContext(r.Context(), p)
		if err != nil {
			http.Error(w, "读取已取消", http.StatusRequestTimeout)
			return
		}
		defer release()
		serveFile(w, r, p)
		return
	}
	http.NotFound(w, r)
}

func (c *Core) serveLive(w http.ResponseWriter, r *http.Request, id, name string) {
	if !safeChannelID(id) || strings.Contains(name, "..") {
		http.NotFound(w, r)
		return
	}
	dir, ok := c.prev.dir(id)
	if !ok {
		if !c.wantedPreviews()[id] {
			http.Error(w, "preview stopped", http.StatusNotFound)
			return
		}
		c.prev.hit(id)
		_ = c.prev.start(id)
		dir = c.previewDir(id)
	} else {
		c.prev.hit(id)
	}
	if name == "index.m3u8" {
		deadline := time.Now().Add(8 * time.Second)
		p := filepath.Join(dir, "index.m3u8")
		for time.Now().Before(deadline) {
			raw, err := os.ReadFile(p)
			if err == nil && len(raw) > 0 {
				body := filterLivePlaylist(dir, raw)
				if len(body) == 0 {
					time.Sleep(200 * time.Millisecond)
					continue
				}
				w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
				w.Header().Set("Content-Length", strconv.Itoa(len(body)))
				_, _ = w.Write(body)
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		http.Error(w, "preview not ready", 503)
		return
	}
	if !strings.HasPrefix(name, "seg_") || !strings.HasSuffix(name, ".ts") {
		http.NotFound(w, r)
		return
	}
	p := filepath.Join(dir, filepath.Base(name))
	w.Header().Set("Content-Type", "video/mp2t")
	http.ServeFile(w, r, p)
}

func serveFile(w http.ResponseWriter, r *http.Request, path string) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".ts":
		w.Header().Set("Content-Type", "video/mp2t")
	case ".mp4":
		w.Header().Set("Content-Type", "video/mp4")
	}
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}

func (c *Core) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.NotFound(w, r)
		return
	}
	sub, err := subFS()
	if err != nil {
		http.Error(w, "ui missing", 500)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if f, err := sub.Open(path); err == nil {
		st, err := f.Stat()
		_ = f.Close()
		if err == nil && !st.IsDir() {
			http.FileServer(http.FS(sub)).ServeHTTP(w, r)
			return
		}
	}
	if strings.HasPrefix(path, "assets/") || (strings.Contains(path, ".") && !strings.HasSuffix(path, ".html")) {
		http.NotFound(w, r)
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/index.html"
	http.FileServer(http.FS(sub)).ServeHTTP(w, r2)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, (8<<20)+1))
	if err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(body)
	if len(body) > 8<<20 || len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("请求必须是大小不超过 8 MiB 的 JSON 对象")
	}
	return json.Unmarshal(trimmed, v)
}

func ListenAddr(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}
