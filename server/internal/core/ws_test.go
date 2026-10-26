package core

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Decode server frames independently of the limited client-command parser.
func readServerFrame(r io.Reader) ([]byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	if hdr[0] != 0x81 || hdr[1]&0x80 != 0 {
		return nil, fmt.Errorf("invalid server text frame: %x", hdr)
	}
	n := uint64(hdr[1])
	if n == 126 {
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return nil, err
		}
		n = uint64(binary.BigEndian.Uint16(ext[:]))
	} else if n == 127 {
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return nil, err
		}
		n = binary.BigEndian.Uint64(ext[:])
	}
	if n > 4<<20 {
		return nil, fmt.Errorf("unexpected size %d", n)
	}
	b := make([]byte, int(n))
	_, err := io.ReadFull(r, b)
	return b, err
}

func TestWSLargeSnapshots(t *testing.T) {
	for _, n := range []int{0, 125, 126, 65535, 65536, 2 << 20} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			payload := bytes.Repeat([]byte("x"), n)
			var out bytes.Buffer
			if err := writeWSFrame(&out, 1, payload); err != nil {
				t.Fatal(err)
			}
			got, err := readServerFrame(&out)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, payload) {
				t.Fatal("snapshot changed")
			}
		})
	}
}

func TestWSOverflowDisconnectsForResync(t *testing.T) {
	server, peer := net.Pipe()
	defer peer.Close()
	hub := newWSHub()
	cl := hub.add(server, bufio.NewReader(server))
	defer hub.remove(cl)
	for i := 0; i < cap(cl.out); i++ {
		cl.send([]byte("snapshot"))
	}
	cl.send([]byte("latest snapshot"))
	select {
	case <-cl.done:
	default:
		t.Fatal("overflow silently lost latest snapshot")
	}
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	var b [1]byte
	if _, err := peer.Read(b[:]); err != io.EOF {
		t.Fatalf("transport still open: %v", err)
	}
}

func TestWSSlowWriterDoesNotBlockWatchersOrHealthyClients(t *testing.T) {
	hub := newWSHub()
	server, slow := net.Pipe()
	defer slow.Close()
	started := make(chan struct{})
	cl := hub.add(&observedWSConn{Conn: server, started: started}, bufio.NewReader(server))
	defer hub.remove(cl)
	cl.watch = "camera"
	exited := make(chan struct{})
	go func() { cl.writeLoop(); close(exited) }()
	cl.send(bytes.Repeat([]byte("x"), 2<<20))
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("writer did not start")
	}
	watched := make(chan struct{})
	go func() { hub.watchers(); close(watched) }()
	select {
	case <-watched:
	case <-time.After(time.Second):
		t.Fatal("network write held subscription lock")
	}
	healthyServer, healthyPeer := net.Pipe()
	defer healthyPeer.Close()
	healthy := hub.add(healthyServer, bufio.NewReader(healthyServer))
	defer hub.remove(healthy)
	go healthy.writeLoop()
	healthy.send([]byte("healthy snapshot"))
	_ = healthyPeer.SetReadDeadline(time.Now().Add(time.Second))
	got, err := readServerFrame(healthyPeer)
	if err != nil || string(got) != "healthy snapshot" {
		t.Fatalf("healthy client: %q %v", got, err)
	}
	select {
	case <-exited:
	case <-time.After(6 * time.Second):
		t.Fatal("slow writer did not time out")
	}
	select {
	case <-cl.done:
	default:
		t.Fatal("write failure left transport alive")
	}
}

type observedWSConn struct {
	net.Conn
	started chan struct{}
	once    sync.Once
}

func (c *observedWSConn) Write(b []byte) (int, error) {
	c.once.Do(func() { close(c.started) })
	return c.Conn.Write(b)
}

func TestWSSubscriptionGetsSnapshotWithUnchangedFingerprint(t *testing.T) {
	c := isolatedCore(t)
	oldServer, oldPeer := net.Pipe()
	defer oldPeer.Close()
	old := c.ws.add(oldServer, bufio.NewReader(oldServer))
	defer c.ws.remove(old)
	old.watch = "test"
	c.pushTimeline("test")
	<-old.out
	// A cached channel fingerprint must not suppress the first snapshot for
	// another viewer, nor should that viewer's subscription rebroadcast to old.
	server, peer := net.Pipe()
	defer peer.Close()
	cl := c.ws.add(server, bufio.NewReader(server))
	defer c.ws.remove(cl)
	cl.watch = "test"
	c.pushTimelineTo("test", cl)
	select {
	case payload := <-cl.out:
		var msg struct {
			Event string `json:"event"`
			Data  struct {
				ChannelID string `json:"channelId"`
			} `json:"data"`
		}
		if err := json.Unmarshal(payload, &msg); err != nil || msg.Event != "timeline" || msg.Data.ChannelID != "test" {
			t.Fatalf("invalid resync snapshot: %s (%v)", payload, err)
		}
	default:
		t.Fatal("cached fingerprint suppressed resync snapshot")
	}
	select {
	case <-old.out:
		t.Fatal("new subscription rebroadcast old snapshot to existing viewer")
	default:
	}
}

func TestWSLargeTimelineOverHTTPUpgrade(t *testing.T) {
	c := isolatedCore(t)
	srv := httptest.NewServer(http.HandlerFunc(c.handleWS))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	conn, err := net.DialTimeout("tcp", u.Host, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(conn, "GET /api/ws HTTP/1.1\r\nHost: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n", u.Host)
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(conn)
	status, err := r.ReadString('\n')
	if err != nil || !strings.Contains(status, "101 Switching Protocols") {
		t.Fatalf("upgrade: %s %v", status, err)
	}
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\r\n" {
			break
		}
	}
	// Browser client commands are masked. The watch response also synchronizes
	// with server registration before broadcasting the large timeline.
	command := []byte(`{"op":"watch","channelId":"test"}`)
	frame := append([]byte{0x81, 0x80 | byte(len(command)), 1, 2, 3, 4}, command...)
	for i := range command {
		frame[6+i] ^= byte(i%4 + 1)
	}
	if _, err = conn.Write(frame); err != nil {
		t.Fatal(err)
	}
	if _, err = readServerFrame(r); err != nil {
		t.Fatal(err)
	}
	segments := make([]Segment, 10000)
	for i := range segments {
		segments[i] = Segment{ID: fmt.Sprint(i), ChannelID: "test", FileName: fmt.Sprintf("test-%06d.ts", i), SourceVersion: "100000-1792410000000000000"}
	}
	c.ws.broadcast("timeline", map[string]any{"channelId": "test", "segments": segments})
	payload, err := readServerFrame(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) <= 1<<20 {
		t.Fatalf("test snapshot too small: %d", len(payload))
	}
	var msg struct {
		Event string `json:"event"`
		Data  struct {
			Segments []Segment `json:"segments"`
		} `json:"data"`
	}
	if err = json.Unmarshal(payload, &msg); err != nil || msg.Event != "timeline" || len(msg.Data.Segments) != len(segments) {
		t.Fatalf("large timeline lost: %d %v", len(msg.Data.Segments), err)
	}
}

type shortWSWriter struct{ bytes.Buffer }

func (w *shortWSWriter) Write(b []byte) (int, error) {
	if len(b) > 3 {
		b = b[:3]
	}
	return w.Buffer.Write(b)
}
func TestWSHandlesShortWrites(t *testing.T) {
	w := &shortWSWriter{}
	payload := bytes.Repeat([]byte("x"), 65536)
	if err := writeWSFrame(w, 1, payload); err != nil {
		t.Fatal(err)
	}
	got, err := readServerFrame(&w.Buffer)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("short write corrupted frame: %v", err)
	}
}
