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
	"strconv"
	"strings"
	"sync"
	"time"
)

type recSession struct {
	exited   bool
	exitText string
	done     chan struct{}
	cmd      *exec.Cmd
	ext      *os.Process // ffmpeg this process did not spawn
	started  time.Time
	reason   string // manual | schedule
	dir      string
	cached   bool
	errBuf   *limitedBuf
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
	c            *Core
	opMu         sync.Mutex
	mu           sync.Mutex
	sess         map[string]*recSession
	archiveLogMu sync.Mutex
	archiveLogAt map[string]time.Time
}

func newRecorder(c *Core) *recorder {
	return &recorder{
		c:    c,
		sess: map[string]*recSession{},
	}
}

var ffScan struct {
	mu        sync.Mutex
	at        time.Time
	processes []recordingProcess
}

type recordingProcess struct {
	PID    int
	Output string
}

func (c *Core) recordingFfmpegByChannel() map[string][]int {
	ffScan.mu.Lock()
	defer ffScan.mu.Unlock()
	if ffScan.at.IsZero() || time.Since(ffScan.at) >= 2*time.Second {
		ffScan.processes = scanRecordingFfmpeg()
		ffScan.at = time.Now()
	}
	return recordingsForRoots(ffScan.processes, []string{c.recordingsRoot(), c.cacheRoot()})
}

func recordingsForRoots(processes []recordingProcess, roots []string) map[string][]int {
	found := map[string][]int{}
	for _, process := range processes {
		dir := filepath.Dir(process.Output)
		id := filepath.Base(dir)
		if process.PID <= 0 || !filepath.IsAbs(process.Output) || !safeChannelID(id) {
			continue
		}
		for _, root := range roots {
			if root != "" && samePath(filepath.Dir(dir), root) {
				found[id] = append(found[id], process.PID)
				break
			}
		}
	}
	return found
}

func recordingOutput(args []string) string {
	if len(args) < 2 {
		return ""
	}
	segment, format, strftime := false, false, false
	for i := 1; i+1 < len(args); i++ {
		switch args[i] {
		case "-f":
			segment = args[i+1] == "segment"
		case "-segment_format":
			format = args[i+1] == "mpegts"
		case "-strftime":
			strftime = args[i+1] == "1"
		}
	}
	output := args[len(args)-1]
	if !segment || !format || !strftime || !strings.HasSuffix(output, segmentStrftimeSuffix) {
		return ""
	}
	return output
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
		exited = s.exited
	} else {
		exited = !processAlive(proc.Pid)
	}
	if exited {
		msg := ""
		if s.errBuf != nil {
			msg = strings.TrimSpace(s.errBuf.String())
		}
		if msg == "" {
			if s.cmd != nil && s.exited {
				msg = "录像进程已退出（" + s.exitText + "）"
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

var secretURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^\s/]*@`)

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
	c.rec.opMu.Lock()
	defer c.rec.opMu.Unlock()
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
	if err := c.rec.startLocked(ch, reason); err != nil {
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
	c.rec.opMu.Lock()
	defer c.rec.opMu.Unlock()
	c.rec.stopLocked(id)
	if manual {
		c.forgetRecord(id)
		c.mu.Lock()
		c.scheduleHold[id] = true
		c.mu.Unlock()
	}
	return nil
}

func (r *recorder) start(ch Channel, reason string) error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	current := r.channel(ch.ID)
	if current.ID == "" || !current.Enabled {
		return errStr("通道不存在或已停用")
	}
	return r.startLocked(current, reason)
}

func (r *recorder) startLocked(ch Channel, reason string) error {
	select {
	case <-r.c.shutdownCh:
		return errStr("服务正在关闭")
	default:
	}
	if r.c.recordingBlocked() {
		return errStr("可用空间不足，录像已暂停")
	}
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
	session := &recSession{cmd: cmd, started: time.Now(), reason: reason, dir: dir, cached: cached, errBuf: eb, done: make(chan struct{})}
	r.mu.Lock()
	r.sess[ch.ID] = session
	r.mu.Unlock()
	go func() {
		err := cmd.Wait()
		r.mu.Lock()
		session.exited = true
		if cmd.ProcessState != nil {
			session.exitText = cmd.ProcessState.String()
		}
		active := r.sess[ch.ID] == session
		r.mu.Unlock()
		close(session.done)
		log.Printf("recording exit channel=%q pid=%d unexpected=%t error=%q detail=%q", ch.ID, cmd.Process.Pid, active, err, redactSecrets(eb.String()))
	}()
	log.Printf("recording start channel=%q pid=%d reason=%q cached=%t output=%q", ch.ID, cmd.Process.Pid, reason, cached, dir)
	return nil
}

func (r *recorder) stop(id string) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.stopLocked(id)
}

func (r *recorder) stopLocked(id string) {
	r.mu.Lock()
	s := r.sess[id]
	delete(r.sess, id)
	r.mu.Unlock()
	if s == nil {
		return
	}
	if proc := s.process(); proc != nil {
		log.Printf("recording stop channel=%q pid=%d", id, proc.Pid)
		_ = proc.Kill()
	}
	if s.done != nil {
		select {
		case <-s.done:
		case <-time.After(2 * time.Second):
		}
	} else {
		time.Sleep(400 * time.Millisecond)
	}
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
		if s.cmd != nil && s.exited {
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
	}
}

func (r *recorder) flushChannel(id string, all bool) {
	cache := r.c.channelCacheDir(id)
	dest := r.c.channelRecordDir(id)
	if cache == "" {
		return
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		r.logArchiveFailure(id, cache, dest, 1, err)
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
	moved, failed := 0, 0
	var firstErr error
	var firstSource, firstDest string
	for i, f := range files {
		if !all && i == newest {
			continue
		}
		if !all && time.Since(f.mod) < 3*time.Second {
			continue
		}
		src := filepath.Join(cache, f.name)
		dst := filepath.Join(dest, f.name)
		if err := r.c.media.leases.move(src, dst); err != nil {
			failed++
			if firstErr == nil {
				firstErr, firstSource, firstDest = err, src, dst
			}
			continue
		}
		moved++
	}
	if moved > 0 {
		log.Printf("recording archive channel=%q moved=%d source=%q destination=%q", id, moved, cache, dest)
	}
	if failed > 0 {
		r.logArchiveFailure(id, firstSource, firstDest, failed, firstErr)
	} else {
		r.archiveLogMu.Lock()
		delete(r.archiveLogAt, id)
		r.archiveLogMu.Unlock()
	}
}

// Report the first failure immediately, then summarize at most once per minute
// per channel. A backlog can contain thousands of conflicting files.
func (r *recorder) logArchiveFailure(id, src, dst string, count int, err error) {
	r.archiveLogMu.Lock()
	defer r.archiveLogMu.Unlock()
	if time.Since(r.archiveLogAt[id]) < time.Minute {
		return
	}
	if r.archiveLogAt == nil {
		r.archiveLogAt = map[string]time.Time{}
	}
	r.archiveLogAt[id] = time.Now()
	log.Printf("recording archive failed channel=%q failed=%d source=%q destination=%q error=%q; cache source retained", id, count, src, dst, redactSecrets(err.Error()))
}

// moveFile renames within a volume and copies across volumes. The cache often
// sits on the data disk while recordings live under the user's Videos folder.
func moveFile(src, dst string) error {
	// Publish without replacing an archive that happens to have the same name.
	if err := publishNew(src, dst); err == nil {
		return nil
	}
	if _, err := os.Stat(dst); err == nil {
		return errStr("归档中已存在同名录像，保留缓存源文件")
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
	out, err := os.CreateTemp(filepath.Dir(dst), ".navora-move-*")
	if err != nil {
		_ = in.Close()
		return err
	}
	tmp := out.Name()
	defer os.Remove(tmp)
	n, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	_ = in.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || n != st.Size() {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if syncErr != nil {
			return syncErr
		}
		return errStr("文件仍在写入")
	}
	current, err := os.Stat(src)
	if err != nil || current.Size() != st.Size() || !current.ModTime().Equal(st.ModTime()) {
		return errStr("源录像已发生变化，保留源文件")
	}
	if err := os.Chtimes(tmp, st.ModTime(), st.ModTime()); err != nil {
		return err
	}
	if err := publishNew(tmp, dst); err != nil {
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
	pids := r.c.recordingFfmpegByChannel()[ch.ID]
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

// Each lane is serial within itself, but file moves and cleanup cannot block
// schedule evaluation, session expiration, preview health or timeline pushes.
func (c *Core) RunLoops() {
	c.rec.adoptAll()
	c.resumeRemembered()
	var lanes sync.WaitGroup
	every := func(period time.Duration, fn func()) {
		lanes.Add(1)
		go func() {
			defer lanes.Done()
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			for {
				select {
				case <-c.shutdownCh:
					return
				case <-ticker.C:
					fn()
				}
			}
		}()
	}
	every(2*time.Second, c.rec.flushAll)
	every(5*time.Second, func() { c.gcSessions(); c.prev.reconcile() })
	every(15*time.Second, c.applySchedule)
	every(2*time.Second, c.pushStates)
	every(2*time.Second, c.pushTimelines)
	every(30*time.Second, func() { c.resumeRemembered(); c.rec.recycle(); c.prev.recycle() })
	every(30*time.Second, c.maybeCleanup)
	every(5*time.Second, c.reconcileMediaMetadata)
	every(5*time.Second, func() {
		info := c.Disk()
		if info.RecordingBlocked {
			c.rec.mu.Lock()
			count := len(c.rec.sess)
			c.rec.mu.Unlock()
			if count > 0 {
				cacheFree := "unavailable"
				if info.CacheFreeBytes != nil {
					cacheFree = strconv.FormatUint(*info.CacheFreeBytes, 10)
				}
				log.Printf("recording paused storage critical recordings=%q freeBytes=%d cacheLevel=%q cacheFreeBytes=%s channels=%d", info.Path, info.FreeBytes, info.CacheLevel, cacheFree, count)
			}
			c.rec.stopAll()
		}
	})
	<-c.shutdownCh
	lanes.Wait()
}
