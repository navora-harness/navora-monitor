package core

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
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
	conn  net.Conn
	br    *bufio.Reader
	mu    sync.Mutex
	out   chan []byte
	done  chan struct{}
	once  sync.Once
	watch string
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
	cl.once.Do(func() { close(cl.done) })
	h.mu.Lock()
	delete(h.client, cl)
	h.mu.Unlock()
	_ = cl.conn.Close()
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
	}
}

func (cl *wsClient) writeLoop() {
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
			cl.mu.Lock()
			err := writeWSFrame(cl.conn, 1, msg)
			cl.mu.Unlock()
			if err != nil {
				return
			}
		case <-ping.C:
			cl.mu.Lock()
			err := writeWSFrame(cl.conn, 9, nil)
			cl.mu.Unlock()
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
			cl.mu.Lock()
			_ = writeWSFrame(cl.conn, 10, payload)
			cl.mu.Unlock()
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
				c.ws.mu.Lock()
				delete(c.ws.fp, id)
				c.ws.mu.Unlock()
				c.pushTimeline(id)
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
	if c.ws == nil || id == "" || !safeChannelID(id) {
		return
	}
	segs := c.ListRecordings(id)
	saved := c.ListSaved(id)
	fp := timelineFP(segs) + "|" + timelineFP(saved)
	if c.ws.sameFP(id, fp) {
		return
	}
	c.ws.setFP(id, fp)
	clients := c.ws.watchers()[id]
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
	for _, cl := range clients {
		cl.send(msg)
	}
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
		return errors.New("frame too large")
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}
