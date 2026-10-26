package core

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type wsHub struct {
	mu     sync.Mutex
	client map[*wsClient]struct{}
	fp     map[string]string
}

func newWSHub() *wsHub {
	return &wsHub{client: map[*wsClient]struct{}{}, fp: map[string]string{}}
}

type wsClient struct {
	conn    net.Conn
	br      *bufio.Reader
	mu      sync.Mutex
	writeMu sync.Mutex
	out     chan []byte
	done    chan struct{}
	once    sync.Once
	watch   string
}

func (h *wsHub) add(conn net.Conn, br *bufio.Reader) *wsClient {
	cl := &wsClient{
		conn: conn,
		br:   br,
		out:  make(chan []byte, 8),
		done: make(chan struct{}),
	}
	h.mu.Lock()
	h.client[cl] = struct{}{}
	h.mu.Unlock()
	return cl
}

func (h *wsHub) remove(cl *wsClient) {
	cl.close()
	h.mu.Lock()
	delete(h.client, cl)
	h.mu.Unlock()
}

// Closing the transport wakes both loops and lets the browser reconnect and
// request a fresh snapshot, including after an overflowing send queue.
func (cl *wsClient) close() {
	cl.once.Do(func() {
		close(cl.done)
		_ = cl.conn.Close()
	})
}

func (h *wsHub) watchers() map[string][]*wsClient {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := map[string][]*wsClient{}
	for cl := range h.client {
		cl.mu.Lock()
		id := cl.watch
		cl.mu.Unlock()
		if id == "" {
			continue
		}
		out[id] = append(out[id], cl)
	}
	return out
}

func (h *wsHub) sameFP(id, fp string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.fp[id] == fp
}

func (h *wsHub) setFP(id, fp string) {
	h.mu.Lock()
	h.fp[id] = fp
	h.mu.Unlock()
}

func (h *wsHub) broadcast(event string, v any) {
	msg, err := json.Marshal(map[string]any{"event": event, "data": v})
	if err != nil {
		return
	}
	h.mu.Lock()
	clients := make([]*wsClient, 0, len(h.client))
	for cl := range h.client {
		clients = append(clients, cl)
	}
	h.mu.Unlock()
	for _, cl := range clients {
		cl.send(msg)
	}
}

func (cl *wsClient) send(b []byte) {
	select {
	case <-cl.done:
	case cl.out <- b:
	default:
		cl.close()
	}
}

func (cl *wsClient) write(opcode byte, payload []byte) error {
	cl.writeMu.Lock()
	defer cl.writeMu.Unlock()
	if err := cl.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return writeWSFrame(cl.conn, opcode, payload)
}

func (cl *wsClient) writeLoop() {
	defer cl.close()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-cl.done:
			return
		case msg, ok := <-cl.out:
			if !ok {
				return
			}
			err := cl.write(1, msg)
			if err != nil {
				return
			}
		case <-ping.C:
			err := cl.write(9, nil)
			if err != nil {
				return
			}
		}
	}
}

func (c *Core) handleWS(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "upgrade required", http.StatusBadRequest)
		return
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	hj, ok := w.(http.Hijacker)
	if !ok || key == "" {
		http.Error(w, "websocket unsupported", http.StatusInternalServerError)
		return
	}
	conn, bufrw, err := hj.Hijack()
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	_, err = bufrw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if err != nil {
		_ = conn.Close()
		return
	}
	if err := bufrw.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	go func() { <-r.Context().Done(); _ = conn.Close() }()
	cl := c.ws.add(conn, bufrw.Reader)
	defer c.ws.remove(cl)
	go cl.writeLoop()
	c.readWS(cl)
}

func (c *Core) readWS(cl *wsClient) {
	for {
		opcode, payload, err := readWSFrame(cl.br)
		if err != nil {
			return
		}
		switch opcode {
		case 8:
			return
		case 9:
			if err := cl.write(10, payload); err != nil {
				return
			}
		case 10:
		case 1:
			var msg struct {
				Op        string `json:"op"`
				ChannelID string `json:"channelId"`
			}
			if json.Unmarshal(payload, &msg) != nil || msg.Op != "watch" {
				continue
			}
			id := strings.TrimSpace(msg.ChannelID)
			cl.mu.Lock()
			cl.watch = id
			cl.mu.Unlock()
			if id != "" {
				c.pushTimelineTo(id, cl)
			}
		}
	}
}

func (c *Core) pushTimelines() {
	if c.ws == nil {
		return
	}
	for id := range c.ws.watchers() {
		c.pushTimeline(id)
	}
}

func (c *Core) pushTimeline(id string) {
	c.pushTimelineTo(id, nil)
}

// A new subscription always receives its own snapshot, independently of the
// shared fingerprint and concurrent updates to other subscribers.
func (c *Core) pushTimelineTo(id string, subscriber *wsClient) {
	if c.ws == nil || id == "" || !safeChannelID(id) {
		return
	}
	// Cheap dir fingerprint first — skip ListRecordings when nothing on disk changed.
	dirFP := c.timelineDirFP(id)
	if subscriber == nil && c.ws.sameFP(id, dirFP) {
		return
	}
	segs := c.ListRecordings(id)
	saved := c.ListSaved(id)
	clients := c.ws.watchers()[id]
	if subscriber != nil {
		clients = []*wsClient{subscriber}
	}
	if len(clients) == 0 {
		return
	}
	msg, err := json.Marshal(map[string]any{
		"event": "timeline",
		"data": map[string]any{
			"channelId": id,
			"segments":  segs,
			"saved":     saved,
		},
	})
	if err != nil {
		return
	}
	if subscriber == nil {
		c.ws.setFP(id, dirFP)
	}
	for _, cl := range clients {
		cl.send(msg)
	}
}

// timelineDirFP is a lightweight name:size:mtime digest of recording/saved dirs.
func (c *Core) timelineDirFP(id string) string {
	var b strings.Builder
	if c.rec.running(id) {
		b.WriteString("recording|")
	}
	roots := []string{c.channelRecordDir(id), c.channelSavedDir(id)}
	if cache := c.channelCacheDir(id); cache != "" {
		roots = append(roots, cache)
	}
	for _, dir := range roots {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		b.WriteString(dir)
		b.WriteByte('|')
		for _, e := range entries {
			if e.IsDir() || (!isRecordingMediaFile(e.Name()) && e.Name() != "index.json") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			b.WriteString(e.Name())
			b.WriteByte(':')
			b.WriteString(itoa64(info.Size()))
			b.WriteByte(':')
			b.WriteString(itoa64(info.ModTime().UnixNano()))
			b.WriteByte(';')
		}
	}
	return b.String()
}

func (c *Core) pushStates() {
	if c.ws == nil {
		return
	}
	c.ws.broadcast("states", c.States())
}

func timelineFP(segs []Segment) string {
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.FileName)
		b.WriteByte(':')
		b.WriteString(itoa64(s.SizeBytes))
		b.WriteByte(':')
		b.WriteString(itoa64(deref(s.StartMs)))
		b.WriteByte(':')
		b.WriteString(itoa64(deref(s.EndMs)))
		b.WriteByte(';')
	}
	return b.String()
}

func itoa64(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func readWSFrame(r *bufio.Reader) (byte, []byte, error) {
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return 0, nil, err
	}
	if hdr[0]&0x80 == 0 {
		return 0, nil, errors.New("fragmented frame")
	}
	opcode := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	ln := int64(hdr[1] & 0x7f)
	switch ln {
	case 126:
		ext := make([]byte, 2)
		if _, err := io.ReadFull(r, ext); err != nil {
			return 0, nil, err
		}
		ln = int64(ext[0])<<8 | int64(ext[1])
	case 127:
		return 0, nil, errors.New("frame too large")
	}
	if ln > 1<<20 {
		return 0, nil, errors.New("frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, ln)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

func writeWSFrame(w io.Writer, opcode byte, payload []byte) error {
	n := len(payload)
	var hdr []byte
	switch {
	case n < 126:
		hdr = []byte{0x80 | opcode, byte(n)}
	case n < 65536:
		hdr = []byte{0x80 | opcode, 126, byte(n >> 8), byte(n)}
	default:
		hdr = make([]byte, 10)
		hdr[0], hdr[1] = 0x80|opcode, 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(n))
	}
	if err := writeWSBytes(w, hdr); err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	return writeWSBytes(w, payload)
}

func writeWSBytes(w io.Writer, b []byte) error {
	for len(b) > 0 {
		n, err := w.Write(b)
		if err != nil {
			return err
		}
		if n <= 0 || n > len(b) {
			return io.ErrShortWrite
		}
		b = b[n:]
	}
	return nil
}
