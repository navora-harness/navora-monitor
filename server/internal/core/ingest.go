package core

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ingestMgr owns the only camera input for a channel. Consumers get loopback
// MPEG-TS URLs, never camera credentials. Only the producer contacts the camera.
// Keep the FFmpeg process boundary so a codec failure cannot crash the service.
type ingestMgr struct {
	mu       sync.Mutex
	c        *Core
	sessions map[string]*ingestSession
	closed   bool
	idle     time.Duration
}

type ingestSession struct {
	channel  Channel
	url      string
	cmd      *exec.Cmd
	server   *http.Server
	pipe     *livePipe
	done     chan struct{}
	stopping chan struct{}
	refs     int // guarded by ingestMgr.mu
	timer    *time.Timer
	stop     sync.Once
	lastRead atomic.Int64
}

type ingestLease struct {
	URL     string
	once    sync.Once
	release func()
}

func (l *ingestLease) Close() {
	if l != nil {
		l.once.Do(l.release)
	}
}

func newIngest(c *Core) *ingestMgr {
	return &ingestMgr{c: c, sessions: map[string]*ingestSession{}, idle: 3 * time.Second}
}

func (m *ingestMgr) acquire(ch Channel) (*ingestLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, errStr("取流服务已停止")
	}
	select {
	case <-m.c.shutdownCh:
		return nil, errStr("服务正在关闭")
	default:
	}
	s := m.sessions[ch.ID]
	if s != nil {
		select {
		case <-s.stopping:
			<-s.done
			s = nil
		default:
		}
	}
	if s != nil && (s.channel.URL != ch.URL || s.channel.RtspTransport != ch.RtspTransport) {
		// Configuration replacement must close the old camera before opening another.
		s.close()
		<-s.done
		s = nil
	}
	if s == nil {
		var err error
		s, err = m.start(ch)
		if err != nil {
			return nil, err
		}
		m.sessions[ch.ID] = s
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.refs++
	return &ingestLease{URL: s.url, release: func() { m.release(ch.ID, s) }}, nil
}

func (m *ingestMgr) release(id string, s *ingestSession) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s.refs--
	if s.refs != 0 || m.sessions[id] != s || m.closed {
		return
	}
	s.timer = time.AfterFunc(m.idle, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.sessions[id] == s && s.refs == 0 {
			// Wait before deleting: a concurrent acquire must not overlap inputs.
			s.close()
			<-s.done
			delete(m.sessions, id)
		}
	})
}

func (m *ingestMgr) start(ch Channel) (*ingestSession, error) {
	bin := m.c.ffmpegPath()
	if bin == "" {
		return nil, errStr("未找到 FFmpeg")
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	path := "/" + hex.EncodeToString(secret[:]) + "/input.ts"
	s := &ingestSession{channel: ch, pipe: newLivePipe(), done: make(chan struct{}), stopping: make(chan struct{})}
	s.url = "http://" + listener.Addr().String() + path
	s.server = &http.Server{ReadHeaderTimeout: 3 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != path || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		s.serve(w, r)
	})}
	s.cmd = exec.Command(bin, buildIngestArgs(ch.URL, ch.RtspTransport)...)
	prepareMediaChild(s.cmd)
	eb := tailBuf(4096)
	s.cmd.Stderr = eb
	stdout, err := s.cmd.StdoutPipe()
	if err != nil {
		listener.Close()
		return nil, err
	}
	if err := s.cmd.Start(); err != nil {
		stdout.Close()
		listener.Close()
		return nil, err
	}
	trackMediaChild(s.cmd)
	s.lastRead.Store(time.Now().UnixNano())
	go func() { _ = s.server.Serve(listener) }()
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := stdout.Read(buf)
			if n > 0 {
				s.lastRead.Store(time.Now().UnixNano())
				s.pipe.publish(buf[:n])
			}
			if readErr != nil {
				break
			}
		}
		err := s.cmd.Wait()
		s.close()
		log.Printf("ingest exit channel=%q error=%q detail=%q", ch.ID, err, redactSecrets(eb.String()))
		close(s.done)
	}()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.done:
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, s.lastRead.Load())) > 20*time.Second {
					log.Printf("ingest stalled channel=%q; closing input", ch.ID)
					s.close()
					return
				}
			}
		}
	}()
	log.Printf("ingest start channel=%q pid=%d", ch.ID, s.cmd.Process.Pid)
	return s, nil
}

func (s *ingestSession) close() {
	s.stop.Do(func() {
		close(s.stopping)
		_ = s.cmd.Process.Kill()
		s.pipe.close()
		_ = s.server.Close()
	})
}

// Bounded, ordered queues isolate consumers. Never skip bytes in a TS stream:
// disconnect an overloaded consumer so its supervisor can restart it instead.
func (s *ingestSession) serve(w http.ResponseWriter, r *http.Request) {
	client := &liveClient{w: w, rc: http.NewResponseController(w), done: make(chan struct{}), queue: make(chan []byte, 128)}
	defer func() {
		client.finish()
		client.detach()
		if client.writerDone != nil {
			<-client.writerDone
		}
		s.pipe.remove(client)
	}()
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	pre, ok := s.pipe.subscribe(client)
	if !ok {
		return
	}
	for _, b := range pre {
		if err := client.write(b); err != nil {
			return
		}
	}
	if err := client.rc.Flush(); err != nil {
		return
	}
	client.startWriter()
	select {
	case <-r.Context().Done():
	case <-client.done:
	}
}

func (m *ingestMgr) stopAll() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for id, s := range m.sessions {
		if s.timer != nil {
			s.timer.Stop()
		}
		s.close()
		<-s.done
		delete(m.sessions, id)
	}
}

// Build a lossless transport, preserving audio for recording. Preview can
// discard audio or transcode video downstream without reopening the camera.
func buildIngestArgs(inputURL, transport string) []string {
	// Do not use nobuffer on the shared input: packets consumed during probing
	// are needed by the recorder too, including the initial keyframe.
	args := []string{"-hide_banner", "-loglevel", "warning", "-fflags", "+genpts+discardcorrupt", "-probesize", "1000000", "-analyzeduration", "1000000"}
	if strings.HasPrefix(strings.ToLower(inputURL), "rtsp://") {
		if transport != "udp" {
			transport = "tcp"
		}
		args = append(args, "-rtsp_transport", transport)
	}
	return append(args, "-i", inputURL, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-bsf:v", "dump_extra=freq=keyframe", "-f", "mpegts", "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1")
}
