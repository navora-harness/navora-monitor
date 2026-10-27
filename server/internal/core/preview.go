package core

import (
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const livePreambleMax = 512 * 1024

// liveClient is one browser reading the continuous MPEG-TS.
// Bytes are written in order. A slow client is disconnected instead of
// skipping packets, which would break the stream and surface as stutter.
type liveClient struct {
	mu         sync.Mutex
	w          http.ResponseWriter
	rc         *http.ResponseController
	done       chan struct{}
	once       sync.Once
	queue      chan []byte
	writerDone chan struct{}
	// waiting is guarded by livePipe.mu; ingest clients wait for a random-access point.
	waiting bool
}

// Each HTTP viewer has a bounded ordered queue. Network writes never hold up
// the shared producer; disconnecting an overloaded viewer preserves TS packets.
func (c *liveClient) enqueue(b []byte) bool {
	if c.queue == nil {
		if c.write(b) == nil {
			return true
		}
		c.finish()
		return false
	}
	select {
	case <-c.done:
		return false
	default:
	}
	select {
	case c.queue <- b:
		return true
	default:
		c.finish()
		return false
	}
}

func (c *liveClient) startWriter() {
	c.writerDone = make(chan struct{})
	go func() {
		defer close(c.writerDone)
		for {
			select {
			case <-c.done:
				return
			default:
			}
			select {
			case <-c.done:
				return
			case b := <-c.queue:
				if c.write(b) != nil {
					c.finish()
					return
				}
			}
		}
	}()
}

func (c *liveClient) write(b []byte) (err error) {
	defer func() {
		if recover() != nil {
			err = errStr("client gone")
		}
	}()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.w == nil {
		return errStr("client gone")
	}
	if c.rc != nil {
		_ = c.rc.SetWriteDeadline(time.Now().Add(3 * time.Second))
	}
	if _, err = c.w.Write(b); err != nil {
		return err
	}
	if c.rc == nil {
		return nil
	}
	if err = c.rc.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	return nil
}

// detach drops the response so a late publish cannot write into a finished request.
func (c *liveClient) detach() {
	c.mu.Lock()
	c.w = nil
	c.rc = nil
	c.mu.Unlock()
}

func (c *liveClient) finish() {
	c.once.Do(func() { close(c.done) })
}

type livePipe struct {
	mu     sync.Mutex
	subs   map[*liveClient]struct{}
	pre    [][]byte
	preN   int
	closed bool
	join   *tsJoinCache
}

func newLivePipe() *livePipe {
	return &livePipe{subs: map[*liveClient]struct{}{}}
}

func (l *livePipe) publish(chunk []byte) {
	var b []byte
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	joinAt := -1
	var headers []byte
	if l.join != nil {
		b, joinAt, headers = l.join.feed(chunk)
	} else {
		b = append([]byte(nil), chunk...)
		l.pre = append(l.pre, b)
		l.preN += len(b)
		for l.preN > livePreambleMax && len(l.pre) > 1 {
			l.preN -= len(l.pre[0])
			l.pre = l.pre[1:]
		}
	}
	type delivery struct {
		client *liveClient
		data   []byte
	}
	clients := make([]delivery, 0, len(l.subs))
	for c := range l.subs {
		if c.waiting {
			if joinAt < 0 {
				continue
			}
			c.waiting = false
			clients = append(clients, delivery{c, headers}, delivery{c, b[joinAt:]})
		} else if len(b) > 0 {
			clients = append(clients, delivery{c, b})
		}
	}
	l.mu.Unlock()
	var dead []*liveClient
	for _, d := range clients {
		if !d.client.enqueue(d.data) {
			dead = append(dead, d.client)
		}
	}
	if len(dead) == 0 {
		return
	}
	l.mu.Lock()
	for _, c := range dead {
		delete(l.subs, c)
	}
	l.mu.Unlock()
}

// Snapshot and subscription are atomic so joining cannot miss stream packets
// between the preamble and the first queued live chunk.
func (l *livePipe) subscribe(c *liveClient) ([][]byte, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		c.finish()
		return nil, false
	}
	l.subs[c] = struct{}{}
	if l.join != nil {
		pre := l.join.snapshot()
		c.waiting = len(pre) == 0
		return pre, true
	}
	return append([][]byte(nil), l.pre...), true
}

func (l *livePipe) preamble() [][]byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.join != nil {
		return l.join.snapshot()
	}
	return append([][]byte(nil), l.pre...)
}

func (l *livePipe) add(c *liveClient) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		c.finish()
		return false
	}
	l.subs[c] = struct{}{}
	return true
}

func (l *livePipe) remove(c *liveClient) {
	l.mu.Lock()
	delete(l.subs, c)
	l.mu.Unlock()
}

func (l *livePipe) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.subs)
}

func (l *livePipe) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	for c := range l.subs {
		c.finish()
		delete(l.subs, c)
	}
}

type prevSession struct {
	exited   bool
	released bool
	cmd      *exec.Cmd
	started  time.Time
	errBuf   *limitedBuf
	lastHit  time.Time
	starting bool
	live     *livePipe
	h264     bool
}

type previewMgr struct {
	c    *Core
	mu   sync.Mutex
	sess map[string]*prevSession
}

func newPreview(c *Core) *previewMgr {
	return &previewMgr{c: c, sess: map[string]*prevSession{}}
}

func (c *Core) previewH264() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.settings.PreviewTranscodeH264 || c.previewNeedH264
}

func (c *Core) NoteNeedPreviewH264() {
	c.mu.Lock()
	already := c.previewNeedH264
	c.previewNeedH264 = true
	c.mu.Unlock()
	if !already {
		c.prev.restartCodecMismatch()
	}
}

func (p *previewMgr) restartCodecMismatch() {
	if p == nil {
		return
	}
	want := p.c.previewH264()
	p.mu.Lock()
	var ids []string
	for id, s := range p.sess {
		if s != nil && s.h264 != want {
			ids = append(ids, id)
		}
	}
	p.mu.Unlock()
	for _, id := range ids {
		p.stop(id)
		_ = p.start(id)
	}
}

func (p *previewMgr) hit(id string) {
	p.mu.Lock()
	if s := p.sess[id]; s != nil {
		s.lastHit = time.Now()
	}
	p.mu.Unlock()
}

func (p *previewMgr) state(id string) (status string, url *string, errp *string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.sess[id]
	u := "/media/live/" + id + "/live.ts"
	if s == nil {
		return "idle", nil, nil
	}
	if s.exited {
		msg := s.errBuf.String()
		if msg == "" {
			msg = "预览进程已退出"
		}
		return "error", nil, strPtr(redactSecrets(msg))
	}
	if s.starting {
		return "starting", &u, nil
	}
	return "live", &u, nil
}

func (p *previewMgr) reconcile() {
	want := p.c.wantedPreviews()
	p.mu.Lock()
	for id, s := range p.sess {
		if want[id] {
			s.released = false
		}
		hit := !s.released && time.Since(s.lastHit) < 20*time.Second
		viewers := 0
		if s.live != nil {
			viewers = s.live.count()
		}
		if want[id] || hit || viewers > 0 {
			continue
		}
		if !s.released && time.Since(s.started) < 8*time.Second {
			continue
		}
		delete(p.sess, id)
		go killPreview(s)
	}
	var missing []string
	for id := range want {
		s := p.sess[id]
		dead := s == nil || (s.exited)
		if dead {
			missing = append(missing, id)
		}
	}
	p.mu.Unlock()
	for _, id := range missing {
		_ = p.start(id)
	}
}

// Explicitly hidden/removed cells need no reconnect grace period. Other
// sessions' wants and active HTTP viewers are still checked by reconcile.
func (p *previewMgr) releaseWanted(ids []string) {
	p.mu.Lock()
	for _, id := range ids {
		if session := p.sess[id]; session != nil {
			session.released = true
		}
	}
	p.mu.Unlock()
}

func killPreview(s *prevSession) {
	if s == nil {
		return
	}
	if s.live != nil {
		s.live.close()
	}
	if s.cmd == nil || s.cmd.Process == nil {
		return
	}
	_ = s.cmd.Process.Kill()
}

func (p *previewMgr) start(id string) error {
	p.mu.Lock()
	if s := p.sess[id]; s != nil {
		alive := s.cmd != nil && s.cmd.Process != nil && !s.exited
		// starting+nil cmd = reserved by an in-flight start (avoids double FFmpeg).
		if alive || (s.starting && s.cmd == nil) {
			p.mu.Unlock()
			return nil
		}
	}
	pipe := newLivePipe()
	if p.c.ingest != nil {
		pipe.join = &tsJoinCache{}
	}
	h264 := p.c.previewH264()
	p.sess[id] = &prevSession{started: time.Now(), lastHit: time.Now(), starting: true, live: pipe, h264: h264}
	p.mu.Unlock()

	failReserve := func(err error) error {
		p.mu.Lock()
		if cur := p.sess[id]; cur != nil && cur.live == pipe && cur.cmd == nil {
			delete(p.sess, id)
		}
		p.mu.Unlock()
		pipe.close()
		return err
	}

	p.c.mu.Lock()
	ch, ok := p.c.channelByID(id)
	p.c.mu.Unlock()
	if !ok {
		return failReserve(errStr("通道不存在"))
	}
	if !ch.Enabled {
		return failReserve(errStr("通道已停用"))
	}
	bin := p.c.ffmpegPath()
	if bin == "" {
		return failReserve(errStr("未找到 FFmpeg"))
	}
	input := ch.URL
	if ch.PreviewURL != "" {
		input = ch.PreviewURL
	}
	var lease *ingestLease
	if p.c.ingest != nil {
		// Shared mode always uses the recording source, including for low-res preview.
		var err error
		lease, err = p.c.ingest.acquire(ch)
		if err != nil {
			return failReserve(err)
		}
		input = lease.URL
	}
	args := buildMpegtsPreviewArgs(input, ch.RtspTransport, h264)
	if lease != nil {
		args = sharedConsumerArgs(args)
		args = append(args[:len(args)-1], "-mpegts_start_pid", "256", "-mpegts_pmt_start_pid", "4096", "-bsf:v", "dump_extra=freq=keyframe", "pipe:1")
	}
	cmd := exec.Command(bin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		lease.Close()
		return failReserve(err)
	}
	prepareMediaChild(cmd)
	eb := tailBuf(4096)
	cmd.Stderr = eb
	if err := cmd.Start(); err != nil {
		stdout.Close()
		lease.Close()
		return failReserve(err)
	}
	trackMediaChild(cmd)
	p.mu.Lock()
	cur := p.sess[id]
	if cur == nil || cur.live != pipe {
		p.mu.Unlock()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		lease.Close()
		pipe.close()
		return nil
	}
	cur.cmd = cmd
	cur.errBuf = eb
	p.mu.Unlock()
	go func() {
		defer func() {
			_ = cmd.Wait()
			lease.Close()
			p.mu.Lock()
			if s := p.sess[id]; s != nil && s.cmd == cmd {
				s.exited = true
				s.starting = false
			}
			p.mu.Unlock()
			pipe.close()
		}()
		buf := make([]byte, 32*1024)
		saw := false
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				if !saw {
					saw = true
					p.mu.Lock()
					if s := p.sess[id]; s != nil && s.cmd == cmd {
						s.starting = false
					}
					p.mu.Unlock()
				}
				pipe.publish(buf[:n])
			}
			if err != nil {
				pipe.close()
				return
			}
		}
	}()
	return nil
}

func (p *previewMgr) serveStream(w http.ResponseWriter, r *http.Request, id string) {
	if !safeChannelID(id) {
		http.NotFound(w, r)
		return
	}
	want := p.c.wantedPreviews()
	p.mu.Lock()
	existing := p.sess[id] != nil
	p.mu.Unlock()
	// Do not revive an explicitly stopped preview just because a player reconnects.
	if !want[id] && !existing {
		http.Error(w, "preview stopped", http.StatusNotFound)
		return
	}
	p.hit(id)
	_ = p.start(id)
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	deadline := time.Now().Add(12 * time.Second)
	var pipe *livePipe
	for pipe == nil && time.Now().Before(deadline) {
		p.mu.Lock()
		if s := p.sess[id]; s != nil {
			pipe = s.live
		}
		p.mu.Unlock()
		if pipe != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if pipe == nil {
		http.Error(w, "preview not ready", 503)
		return
	}
	client := &liveClient{
		w:     w,
		rc:    http.NewResponseController(w),
		done:  make(chan struct{}),
		queue: make(chan []byte, 16),
	}
	defer func() {
		client.finish()
		client.detach()
		if client.writerDone != nil {
			<-client.writerDone
		}
		pipe.remove(client)
	}()
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	// Join after the status line so publish cannot write the body first,
	// and drop the writer before this handler returns.
	pre, subscribed := pipe.subscribe(client)
	if !subscribed {
		return
	}
	for _, b := range pre {
		if err := client.write(b); err != nil {
			return
		}
	}
	flusher.Flush()
	client.startWriter()
	select {
	case <-r.Context().Done():
	case <-client.done:
	}
}

func (p *previewMgr) stop(id string) {
	p.mu.Lock()
	s := p.sess[id]
	delete(p.sess, id)
	p.mu.Unlock()
	killPreview(s)
}

func (p *previewMgr) recycle() {
	p.mu.Lock()
	var ids []string
	for id, s := range p.sess {
		if time.Since(s.started) > 60*time.Minute {
			ids = append(ids, id)
		}
	}
	p.mu.Unlock()
	for _, id := range ids {
		p.stop(id)
		_ = p.start(id)
	}
}

// filterLivePlaylist drops segment files that ffmpeg already deleted.
// append_list used to keep every name in the playlist while delete_segments
// removed the files, so the player requested seg_00xxx.ts and got 404.
func filterLivePlaylist(dir string, raw []byte) []byte {
	type seg struct {
		inf string
		uri string
	}
	var segs []seg
	var pending string
	for _, line := range strings.Split(string(raw), "\n") {
		t := strings.TrimSpace(line)
		if t == "" || t == "#EXT-X-ENDLIST" || strings.HasPrefix(t, "#EXT-X-MEDIA-SEQUENCE") {
			continue
		}
		if strings.HasPrefix(t, "#EXTINF") {
			pending = t
			continue
		}
		if strings.HasPrefix(t, "#") {
			continue
		}
		name := filepath.Base(strings.Split(t, "?")[0])
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil || st.IsDir() || st.Size() < 64 {
			pending = ""
			continue
		}
		segs = append(segs, seg{inf: pending, uri: name})
		pending = ""
	}
	if len(segs) > 1 {
		segs = segs[1:]
	}
	if len(segs) > 6 {
		segs = segs[len(segs)-6:]
	}
	if len(segs) == 0 {
		return nil
	}
	seq := segFileIndex(segs[0].uri)
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:")
	b.WriteString(strconv.Itoa(seq))
	b.WriteByte('\n')
	for _, s := range segs {
		if s.inf != "" {
			b.WriteString(s.inf)
			b.WriteByte('\n')
		} else {
			b.WriteString("#EXTINF:2.000,\n")
		}
		b.WriteString(s.uri)
		b.WriteByte('\n')
	}
	return []byte(b.String())
}

func segFileIndex(name string) int {
	base := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	i := strings.LastIndex(base, "_")
	if i < 0 || i == len(base)-1 {
		return 0
	}
	n, err := strconv.Atoi(base[i+1:])
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func (p *previewMgr) dir(id string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sess[id] == nil {
		return "", false
	}
	return p.c.previewDir(id), true
}
