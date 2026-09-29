package core

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type recSession struct {
	cmd     *exec.Cmd
	ext     *os.Process // ffmpeg this process did not spawn
	started time.Time
	reason  string // manual | schedule
	dir     string
	cached  bool
	errBuf  *limitedBuf
}

func (s *recSession) process() *os.Process {
	if s == nil {
		return nil
	}
	if s.cmd != nil && s.cmd.Process != nil {
		return s.cmd.Process
	}
	return s.ext
}

type recorder struct {
	c    *Core
	mu   sync.Mutex
	sess map[string]*recSession
	// path -> fail count for auto normalize
	fail map[string]int
	// path currently queued/running normalize (prevents goroutine stampede)
	pending map[string]bool
}

func newRecorder(c *Core) *recorder {
	return &recorder{
		c:       c,
		sess:    map[string]*recSession{},
		fail:    map[string]int{},
		pending: map[string]bool{},
	}
}

var ffScan struct {
	mu sync.Mutex
	at time.Time
	m  map[string][]int
}

func recordingFfmpegByChannel() map[string][]int {
	ffScan.mu.Lock()
	defer ffScan.mu.Unlock()
	if ffScan.m != nil && time.Since(ffScan.at) < 2*time.Second {
		return ffScan.m
	}
	ffScan.m = scanRecordingFfmpeg()
	if ffScan.m == nil {
		ffScan.m = map[string][]int{}
	}
	ffScan.at = time.Now()
	return ffScan.m
}

type runtimeState struct {
	ID           string  `json:"id"`
	Recording    string  `json:"recording"`
	Pid          *int    `json:"pid"`
	LastError    *string `json:"lastError"`
	OutputDir    *string `json:"outputDir"`
	StartedAt    *string `json:"startedAt"`
	Preview      string  `json:"preview"`
	PreviewURL   *string `json:"previewUrl"`
	PreviewError *string `json:"previewError"`
}

func (r *recorder) state(id string) (recording string, pid *int, last *string, dir *string, started *string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sess[id]
	proc := s.process()
	if proc == nil {
		return "idle", nil, nil, nil, nil
	}
	exited := false
	if s.cmd != nil {
		exited = s.cmd.ProcessState != nil && s.cmd.ProcessState.Exited()
	} else {
		exited = !processAlive(proc.Pid)
	}
	if exited {
		msg := ""
		if s.errBuf != nil {
			msg = strings.TrimSpace(s.errBuf.String())
		}
		if msg == "" {
			if s.cmd != nil && s.cmd.ProcessState != nil {
				msg = "录像进程已退出（" + s.cmd.ProcessState.String() + "）"
			} else {
				msg = "录像进程已退出"
			}
		}
		return "error", nil, strPtr(redactSecrets(msg)), strPtr(s.dir), nil
	}
	p := proc.Pid
	st := s.started.UTC().Format(time.RFC3339)
	return "recording", &p, nil, strPtr(s.dir), &st
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var secretURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^\s/@]+(?::[^\s/@]*)?@`)

func redactSecrets(s string) string {
	return secretURL.ReplaceAllString(s, "${1}")
}

func (r *recorder) running(id string) bool {
	rec, _, _, _, _ := r.state(id)
	return rec == "recording"
}

func (c *Core) States() []runtimeState {
	channels := c.Channels()
	out := make([]runtimeState, 0, len(channels))
	for _, ch := range channels {
		rec, pid, last, dir, started := c.rec.state(ch.ID)
		prev, pURL, pErr := c.prev.state(ch.ID)
		out = append(out, runtimeState{
			ID:           ch.ID,
			Recording:    rec,
			Pid:          pid,
			LastError:    last,
			OutputDir:    dir,
			StartedAt:    started,
			Preview:      prev,
			PreviewURL:   pURL,
			PreviewError: pErr,
		})
	}
	return out
}

func (c *Core) StartRecord(id, reason string) (runtimeState, error) {
	if reason == "" {
		reason = "manual"
	}
	c.mu.Lock()
	ch, ok := c.channelByID(id)
	c.mu.Unlock()
	if !ok {
		return runtimeState{}, errStr("通道不存在")
	}
	if !ch.Enabled {
		return runtimeState{}, errStr("通道已停用")
	}
	if c.recordingBlocked() {
		return runtimeState{}, errStr("磁盘空间不足，已禁止录像")
	}
	if c.rec.claimExternal(ch, reason) {
		if reason == "manual" {
			c.rememberRecord(id)
		}
		st := c.States()
		for _, s := range st {
			if s.ID == id {
				return s, nil
			}
		}
		return runtimeState{ID: id, Recording: "recording", Preview: "idle"}, nil
	}
	if err := c.rec.start(ch, reason); err != nil {
		return runtimeState{}, err
	}
	c.mu.Lock()
	delete(c.scheduleHold, id)
	c.mu.Unlock()
	if reason == "manual" {
		c.rememberRecord(id)
	}
	st := c.States()
	for _, s := range st {
		if s.ID == id {
			return s, nil
		}
	}
	return runtimeState{ID: id, Recording: "recording", Preview: "idle"}, nil
}

func (c *Core) StopRecord(id string, manual bool) error {
	c.rec.stop(id)
	if manual {
		c.forgetRecord(id)
		c.mu.Lock()
		c.scheduleHold[id] = true
		c.mu.Unlock()
	}
	return nil
}

func (r *recorder) start(ch Channel, reason string) error {
	r.mu.Lock()
	if s := r.sess[ch.ID]; s != nil {
		if p := s.process(); p != nil && processAlive(p.Pid) {
			r.mu.Unlock()
			return nil
		}
	}
	r.mu.Unlock()
	if r.claimExternal(ch, reason) {
		return nil
	}

	bin := r.c.ffmpegPath()
	if bin == "" {
		return errStr("未找到 FFmpeg")
	}
	dir, cached := r.c.writeDir(ch.ID)
	stem := sanitizeFileStem(ch.Name)
	pattern := filepath.Join(dir, stem+"-"+segmentStrftimeSuffix)
	seg := ch.SegmentTimeSec
	if seg < 10 {
		seg = 300
	}
	args := buildSegmentRecordArgs(ch.URL, pattern, ch.Name, ch.RtspTransport, seg)
	cmd := exec.Command(bin, args...)
	prepareMediaChild(cmd)
	eb := tailBuf(4096)
	cmd.Stderr = eb
	cmd.Stdout = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	trackMediaChild(cmd)
	go func() { _ = cmd.Wait() }()
	r.mu.Lock()
	r.sess[ch.ID] = &recSession{cmd: cmd, started: time.Now(), reason: reason, dir: dir, cached: cached, errBuf: eb}
	r.mu.Unlock()
	return nil
}

func (r *recorder) stop(id string) {
	r.mu.Lock()
	s := r.sess[id]
	delete(r.sess, id)
	r.mu.Unlock()
	if s == nil {
		return
	}
	if proc := s.process(); proc != nil {
		_ = proc.Kill()
	}
	time.Sleep(400 * time.Millisecond)
	r.flushChannel(id, true)
}

func (r *recorder) stopAll() {
	r.mu.Lock()
	ids := make([]string, 0, len(r.sess))
	for id := range r.sess {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.stop(id)
	}
}

func (c *Core) recordingBlocked() bool {
	info := c.Disk()
	return info.RecordingBlocked
}

func (r *recorder) recycle() {
	r.mu.Lock()
	var old []string
	for id, s := range r.sess {
		if time.Since(s.started) > 90*time.Minute {
			old = append(old, id)
		}
		if s.cmd != nil && s.cmd.ProcessState != nil && s.cmd.ProcessState.Exited() {
			old = append(old, id)
		}
	}
	reasons := map[string]string{}
	for _, id := range old {
		if s := r.sess[id]; s != nil {
			reasons[id] = s.reason
		}
	}
	r.mu.Unlock()
	for _, id := range old {
		ch := r.channel(id)
		reason := reasons[id]
		r.stop(id)
		if ch.ID != "" && ch.Enabled {
			_ = r.start(ch, reason)
		}
	}
}

func (r *recorder) channel(id string) Channel {
	r.c.mu.Lock()
	defer r.c.mu.Unlock()
	ch, _ := r.c.channelByID(id)
	return ch
}

func (r *recorder) flushAll() {
	for _, ch := range r.c.Channels() {
		// Finished cache files must move even when this process did not start
		// the recorder. When nothing is writing, the newest file is finished too.
		r.flushChannel(ch.ID, !r.running(ch.ID))
		r.finalizeStable(ch.ID, false)
	}
}

func (r *recorder) flushChannel(id string, all bool) {
	cache := r.c.channelCacheDir(id)
	dest := r.c.channelRecordDir(id)
	if cache == "" {
		r.finalizeStable(id, false)
		return
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		return
	}
	type item struct {
		name string
		mod  time.Time
	}
	var files []item
	for _, e := range entries {
		if e.IsDir() || !isRecordingMediaFile(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, item{e.Name(), info.ModTime()})
	}
	if len(files) == 0 {
		return
	}
	newest := 0
	for i := 1; i < len(files); i++ {
		if files[i].mod.After(files[newest].mod) {
			newest = i
		}
	}
	for i, f := range files {
		if !all && i == newest {
			continue
		}
		if !all && time.Since(f.mod) < 3*time.Second {
			continue
		}
		src := filepath.Join(cache, f.name)
		dst := filepath.Join(dest, f.name)
		if err := moveFile(src, dst); err != nil {
			continue
		}
		r.normalizeLater(dst)
	}
}

func (r *recorder) finalizeStable(id string, fromCache bool) {
	if fromCache {
		r.flushChannel(id, false)
		return
	}
	dir := r.c.channelRecordDir(id)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type item struct {
		path string
		mod  time.Time
	}
	var files []item
	for _, e := range entries {
		if e.IsDir() || !isRecordingMediaFile(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, item{filepath.Join(dir, e.Name()), info.ModTime()})
	}
	if len(files) == 0 {
		return
	}
	newest := 0
	for i := 1; i < len(files); i++ {
		if files[i].mod.After(files[newest].mod) {
			newest = i
		}
	}
	writing := r.running(id)
	for i, f := range files {
		if writing && i == newest {
			continue
		}
		if isSegmentWriting(f.mod.UnixMilli(), time.Now().UnixMilli()) {
			continue
		}
		if _, err := os.Stat(f.path + ".normed"); err == nil {
			continue
		}
		r.normalizeLater(f.path)
	}
}

func (r *recorder) normalizeLater(path string) {
	if !stringsHasSuffixFold(path, ".ts") {
		return
	}
	if _, err := os.Stat(path + ".normed"); err == nil {
		return
	}
	r.mu.Lock()
	if r.fail[path] >= 3 {
		r.mu.Unlock()
		// Permanent skip so flushAll stops re-queueing this file forever.
		_ = os.WriteFile(path+".normed", []byte("skip"), 0o644)
		r.mu.Lock()
		delete(r.fail, path)
		r.mu.Unlock()
		return
	}
	if r.pending[path] {
		r.mu.Unlock()
		return
	}
	r.pending[path] = true
	r.mu.Unlock()

	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.pending, path)
			r.mu.Unlock()
		}()
		r.c.media.withExclusive(func() {
			if isSegmentWriting(modTimeMs(path), time.Now().UnixMilli()) {
				return
			}
			if _, err := os.Stat(path + ".normed"); err == nil {
				return
			}
			r.mu.Lock()
			fails := r.fail[path]
			r.mu.Unlock()
			if fails >= 3 {
				_ = os.WriteFile(path+".normed", []byte("skip"), 0o644)
				r.mu.Lock()
				delete(r.fail, path)
				r.mu.Unlock()
				return
			}
			if r.c.normalizeTS(path) {
				_ = os.WriteFile(path+".normed", []byte("ok"), 0o644)
				r.mu.Lock()
				delete(r.fail, path)
				r.mu.Unlock()
				return
			}
			r.mu.Lock()
			r.fail[path] = fails + 1
			n := r.fail[path]
			r.mu.Unlock()
			if n >= 3 {
				_ = os.WriteFile(path+".normed", []byte("skip"), 0o644)
				r.mu.Lock()
				delete(r.fail, path)
				r.mu.Unlock()
			}
		})
	}()
}

func (r *recorder) pruneNormalizeState() {
	r.mu.Lock()
	paths := make([]string, 0, len(r.fail)+len(r.pending))
	for p := range r.fail {
		paths = append(paths, p)
	}
	for p := range r.pending {
		paths = append(paths, p)
	}
	r.mu.Unlock()
	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			continue
		}
		r.mu.Lock()
		delete(r.fail, path)
		delete(r.pending, path)
		r.mu.Unlock()
	}
}

// moveFile renames within a volume and copies across volumes. The cache often
// sits on the data disk while recordings live under the user's Videos folder.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	st, err := in.Stat()
	if err != nil {
		_ = in.Close()
		return err
	}
	tmp := dst + ".part"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		_ = in.Close()
		return err
	}
	n, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	_ = in.Close()
	if copyErr != nil || closeErr != nil || n != st.Size() {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		return errStr("文件仍在写入")
	}
	if stDst, err := os.Stat(dst); err == nil {
		if stDst.Size() == st.Size() {
			_ = os.Remove(tmp)
			return os.Remove(src)
		}
		_ = os.Remove(dst)
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chtimes(dst, st.ModTime(), st.ModTime())
	return os.Remove(src)
}

func modTimeMs(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.ModTime().UnixMilli()
}

func stringsHasSuffixFold(s, suf string) bool {
	if len(s) < len(suf) {
		return false
	}
	return stringsEqualFold(s[len(s)-len(suf):], suf)
}

func (c *Core) applySchedule() {
	now := time.Now()
	channels := c.Channels()
	for _, ch := range channels {
		active := ch.Enabled && isScheduleActive(ch.Schedule, now)
		c.mu.Lock()
		held := c.scheduleHold[ch.ID]
		if !active {
			delete(c.scheduleHold, ch.ID)
			held = false
		}
		c.mu.Unlock()
		running := c.rec.running(ch.ID)
		if active && !running && !held {
			_, _ = c.StartRecord(ch.ID, "schedule")
		}
		if !active && running {
			c.rec.mu.Lock()
			s := c.rec.sess[ch.ID]
			reason := ""
			if s != nil {
				reason = s.reason
			}
			c.rec.mu.Unlock()
			if reason == "schedule" {
				_ = c.StopRecord(ch.ID, false)
			}
		}
	}
}

func (r *recorder) claimExternal(ch Channel, reason string) bool {
	pids := recordingFfmpegByChannel()[ch.ID]
	var alive []int
	for _, pid := range pids {
		if processAlive(pid) {
			alive = append(alive, pid)
		}
	}
	if len(alive) == 0 {
		return false
	}
	r.mu.Lock()
	owned := 0
	if s := r.sess[ch.ID]; s != nil {
		if p := s.process(); p != nil && processAlive(p.Pid) {
			owned = p.Pid
		}
	}
	r.mu.Unlock()
	keep := owned
	if keep == 0 {
		sort.Ints(alive)
		keep = alive[len(alive)-1]
	}
	for _, pid := range alive {
		if pid == keep {
			continue
		}
		if p, err := os.FindProcess(pid); err == nil {
			_ = p.Kill()
			log.Printf("recording %s stopped duplicate ffmpeg pid=%d", ch.ID, pid)
		}
	}
	if owned != 0 {
		return true
	}
	proc, err := os.FindProcess(keep)
	if err != nil {
		return false
	}
	dir, cached := r.c.writeDir(ch.ID)
	r.mu.Lock()
	r.sess[ch.ID] = &recSession{
		ext: proc, started: time.Now(), reason: reason, dir: dir, cached: cached, errBuf: tailBuf(64),
	}
	r.mu.Unlock()
	trackMediaPID(keep)
	log.Printf("recording %s attached existing ffmpeg pid=%d", ch.ID, keep)
	return true
}

func (r *recorder) adoptAll() {
	for _, ch := range r.c.Channels() {
		_ = r.claimExternal(ch, "manual")
	}
}

func (c *Core) recordingSessionPath() string {
	return filepath.Join(c.root, "recording-session.json")
}

type recordingSessionFile struct {
	Version    int      `json:"version"`
	ChannelIDs []string `json:"channelIds"`
}

func (c *Core) loadRemembered() map[string]bool {
	out := map[string]bool{}
	b, err := os.ReadFile(c.recordingSessionPath())
	if err != nil {
		return out
	}
	var doc recordingSessionFile
	if json.Unmarshal(b, &doc) != nil || doc.ChannelIDs == nil {
		return out
	}
	for _, id := range doc.ChannelIDs {
		id = strings.TrimSpace(id)
		if safeChannelID(id) {
			out[id] = true
		}
	}
	return out
}

func (c *Core) saveRememberedLocked() {
	ids := make([]string, 0, len(c.remembered))
	for id := range c.remembered {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	doc := recordingSessionFile{Version: 1, ChannelIDs: ids}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(c.recordingSessionPath(), b)
}

func (c *Core) rememberRecord(id string) {
	if !safeChannelID(id) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remembered == nil {
		c.remembered = map[string]bool{}
	}
	if c.remembered[id] {
		return
	}
	c.remembered[id] = true
	c.saveRememberedLocked()
}

func (c *Core) forgetRecord(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.remembered == nil || !c.remembered[id] {
		return
	}
	delete(c.remembered, id)
	c.saveRememberedLocked()
}

func (c *Core) forgetRecords(ids []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
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
}

// resumeRemembered restarts manual recordings from recording-session.json.
// Schedule-driven recordings are handled separately by applySchedule.
func (c *Core) resumeRemembered() int {
	if c.recordingBlocked() {
		return 0
	}
	c.mu.Lock()
	ids := make([]string, 0, len(c.remembered))
	for id := range c.remembered {
		ids = append(ids, id)
	}
	c.mu.Unlock()
	if len(ids) == 0 {
		return 0
	}
	known := map[string]bool{}
	for _, ch := range c.Channels() {
		known[ch.ID] = true
	}
	started := 0
	var drop []string
	for _, id := range ids {
		if !known[id] {
			drop = append(drop, id)
			continue
		}
		c.mu.Lock()
		ch, ok := c.channelByID(id)
		c.mu.Unlock()
		if !ok || !ch.Enabled {
			continue
		}
		if c.rec.running(id) {
			continue
		}
		if _, err := c.StartRecord(id, "manual"); err != nil {
			log.Printf("resume recording %s: %v", id, err)
			continue
		}
		started++
	}
	if len(drop) > 0 {
		c.forgetRecords(drop)
	}
	if started > 0 {
		log.Printf("resumed %d remembered recording(s)", started)
	}
	return started
}

func (c *Core) RunLoops() {
	c.rec.adoptAll()
	c.resumeRemembered()
	flush := time.NewTicker(2 * time.Second)
	prev := time.NewTicker(5 * time.Second)
	sched := time.NewTicker(15 * time.Second)
	slow := time.NewTicker(30 * time.Second)
	live := time.NewTicker(time.Second)
	defer flush.Stop()
	defer prev.Stop()
	defer sched.Stop()
	defer slow.Stop()
	defer live.Stop()
	var beat int
	for {
		select {
		case <-c.shutdownCh:
			return
		case <-live.C:
			beat++
			c.pushTimelines()
			if beat%2 == 0 {
				c.pushStates()
			}
		case <-flush.C:
			c.rec.flushAll()
		case <-prev.C:
			c.gcSessions()
			c.prev.reconcile()
		case <-sched.C:
			c.applySchedule()
		case <-slow.C:
			c.resumeRemembered()
			c.rec.pruneNormalizeState()
			c.rec.recycle()
			c.prev.recycle()
			c.maybeCleanup()
		}
	}
}
