package core

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A loopback RTSP camera fixture exercises FFmpeg's actual RTSP demuxer, both
// interleaved TCP and UDP RTP, rather than treating an HTTP TS feed as RTSP.
type rtspCamera struct {
	listener    net.Listener
	bin         string
	mu          sync.Mutex
	connections map[net.Conn]struct{}
	wg          sync.WaitGroup
	requests    atomic.Int32
	bytes       atomic.Uint64
}

func newRTSPCamera(t *testing.T, bin string) *rtspCamera {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	c := &rtspCamera{listener: listener, bin: bin, connections: map[net.Conn]struct{}{}}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			c.mu.Lock()
			c.connections[conn] = struct{}{}
			c.mu.Unlock()
			c.requests.Add(1)
			c.wg.Add(1)
			go func() {
				defer c.wg.Done()
				defer func() { conn.Close(); c.mu.Lock(); delete(c.connections, conn); c.mu.Unlock() }()
				c.serve(conn)
			}()
		}
	}()
	t.Cleanup(func() { listener.Close(); c.disconnect(); c.wg.Wait() })
	return c
}

func (c *rtspCamera) url() string { return "rtsp://" + c.listener.Addr().String() + "/camera" }
func (c *rtspCamera) disconnect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for conn := range c.connections {
		conn.Close()
	}
}

func (c *rtspCamera) serve(conn net.Conn) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rtp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return
	}
	defer rtp.Close()
	var writeMu sync.Mutex
	write := func(b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		_, err := conn.Write(b)
		return err
	}
	reader := bufio.NewReader(conn)
	var destination *net.UDPAddr
	var sender *exec.Cmd
	var forward sync.WaitGroup
	defer func() {
		cancel()
		rtp.Close()
		if sender != nil {
			sender.Wait()
		}
		forward.Wait()
	}()
	for {
		peek, err := reader.Peek(1)
		if err != nil {
			return
		}
		if peek[0] == '$' { // client RTCP over the RTSP control connection
			var header [4]byte
			if _, err := io.ReadFull(reader, header[:]); err != nil {
				return
			}
			if _, err := io.CopyN(io.Discard, reader, int64(binary.BigEndian.Uint16(header[2:]))); err != nil {
				return
			}
			continue
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		headers, err := textproto.NewReader(reader).ReadMIMEHeader()
		if err != nil {
			return
		}
		method := strings.Fields(line)
		if len(method) < 3 {
			return
		}
		extra, body := "", ""
		switch method[0] {
		case "OPTIONS":
			extra = "Public: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN\r\n"
		case "DESCRIBE":
			body = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Navora test camera\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\na=control:*\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\na=control:trackID=0\r\n"
			extra = "Content-Type: application/sdp\r\nContent-Base: " + c.url() + "/\r\n"
		case "SETUP":
			transport := headers.Get("Transport")
			if strings.Contains(transport, "RTP/AVP/TCP") {
				extra = "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n"
			} else {
				port := 0
				for _, part := range strings.Split(transport, ";") {
					if strings.HasPrefix(part, "client_port=") {
						fmt.Sscanf(part, "client_port=%d", &port)
					}
				}
				if port == 0 {
					return
				}
				destination = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port}
				extra = fmt.Sprintf("Transport: RTP/AVP/UDP;unicast;client_port=%d-%d;server_port=%d-%d\r\n", port, port+1, rtp.LocalAddr().(*net.UDPAddr).Port, rtp.LocalAddr().(*net.UDPAddr).Port+1)
			}
		}
		response := fmt.Sprintf("RTSP/1.0 200 OK\r\nCSeq: %s\r\nSession: navora-test\r\n%sContent-Length: %d\r\n\r\n%s", headers.Get("Cseq"), extra, len(body), body)
		if err := write([]byte(response)); err != nil {
			return
		}
		if method[0] == "TEARDOWN" {
			return
		}
		if method[0] == "PLAY" && sender == nil {
			forward.Add(1)
			go func() {
				defer forward.Done()
				packet := make([]byte, 65536)
				for {
					n, _, err := rtp.ReadFromUDP(packet)
					if err != nil {
						return
					}
					c.bytes.Add(uint64(n))
					if destination != nil {
						_, err = rtp.WriteToUDP(packet[:n], destination)
					} else {
						frame := make([]byte, 4+n)
						frame[0] = '$'
						binary.BigEndian.PutUint16(frame[2:4], uint16(n))
						copy(frame[4:], packet[:n])
						err = write(frame)
					}
					if err != nil {
						conn.Close()
						return
					}
				}
			}()
			sender = exec.CommandContext(ctx, c.bin, "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "10", "-bf", "0", "-payload_type", "96", "-f", "rtp", "rtp://"+rtp.LocalAddr().String()+"?pkt_size=1200")
			prepareMediaChild(sender)
			if err := sender.Start(); err != nil {
				sender = nil
				return
			}
		}
	}
}

func TestSharedIngestRTSPTransportsAndRecovery(t *testing.T) {
	bin := ingestFFmpeg(t)
	for _, transport := range []string{"tcp", "udp"} {
		t.Run(transport, func(t *testing.T) {
			camera := newRTSPCamera(t, bin)
			c := isolatedCore(t)
			c.settings.FFmpegPath = bin
			c.ingest = newIngest(c)
			c.ingest.retryBase = 100 * time.Millisecond
			t.Cleanup(c.StopAllMedia)
			ch := Channel{ID: "test", Name: "rtsp", Enabled: true, URL: camera.url(), RtspTransport: transport, SegmentTimeSec: 10}
			c.channels = []Channel{ch}
			c.sessions["watcher"] = &Session{Expires: time.Now().Add(time.Hour), Previews: map[string]time.Time{ch.ID: time.Now()}}
			if _, err := c.StartRecord(ch.ID, "manual"); err != nil {
				t.Fatal(err)
			}
			if err := c.prev.start(ch.ID); err != nil {
				t.Fatal(err)
			}
			waitIngest(t, "RTSP preview did not receive video", func() bool { state, _, _ := c.prev.state(ch.ID); return state == "live" })
			if camera.requests.Load() != 1 || camera.bytes.Load() == 0 {
				t.Fatal("RTSP consumers opened multiple camera connections or received no RTP")
			}
			if ok, _, msg := c.Probe(ch.ID); !ok {
				t.Fatal("shared RTSP probe failed", msg)
			}
			if camera.requests.Load() != 1 {
				t.Fatal("probe opened a redundant RTSP connection")
			}
			camera.disconnect()
			waitIngest(t, "RTSP branches did not recover together", func() bool {
				c.recoverSharedMedia()
				state, _, _ := c.prev.state(ch.ID)
				return camera.requests.Load() == 2 && state == "live" && c.rec.running(ch.ID)
			})
			if c.ingest.status(ch.ID).Consumers != 2 {
				t.Fatal("recovery did not converge on one input")
			}
		})
	}
}
