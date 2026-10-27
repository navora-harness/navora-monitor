package core

import (
	"bytes"
	"context"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func testTSPacket(pid int, key bool) []byte {
	p := bytes.Repeat([]byte{0xff}, tsPacketSize)
	p[0], p[1], p[2], p[3] = 0x47, byte(pid>>8), byte(pid), 0x10
	if key {
		p[1] |= 0x40
		p[3], p[4], p[5] = 0x30, 1, 0x40
	}
	return p
}

func testTSTable(pid int) []byte {
	p := testTSPacket(pid, false)
	p[1] |= 0x40
	p[4], p[5], p[6], p[7] = 0, 0, 0xb0, 4
	return p
}

func TestIngestJoinWaitsForHeadersAndRandomAccess(t *testing.T) {
	pipe := newLivePipe()
	pipe.join = &tsJoinCache{}
	w := httptest.NewRecorder()
	c := &liveClient{w: w, done: make(chan struct{})}
	pre, ok := pipe.subscribe(c)
	if !ok || len(pre) != 0 {
		t.Fatal("new input unexpectedly had bootstrap")
	}
	pipe.publish(testTSPacket(ingestVideoPID, true)) // no tables yet
	pipe.publish(testTSTable(0))
	pipe.publish(testTSTable(ingestPMTPID))
	pipe.publish(testTSPacket(ingestVideoPID, false))
	if w.Body.Len() != 0 {
		t.Fatal("subscriber received undecodable leading packets")
	}
	key := testTSPacket(ingestVideoPID, true)
	// Split a TS packet across reads. Nothing is published until it is complete.
	pipe.publish(key[:83])
	if w.Body.Len() != 0 {
		t.Fatal("partial packet was published")
	}
	pipe.publish(key[83:])
	want := bytes.Join([][]byte{testTSTable(0), testTSTable(ingestPMTPID), key}, nil)
	if !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatal("join did not start with tables and keyframe")
	}
	late := &liveClient{done: make(chan struct{})}
	pre, ok = pipe.subscribe(late)
	if !ok || !bytes.Equal(bytes.Join(pre, nil), want) {
		t.Fatal("late subscriber got an incomplete GOP")
	}
}

func TestIngestJoinCacheAlignsAndBoundsMemory(t *testing.T) {
	j := &tsJoinCache{}
	input := bytes.Join([][]byte{testTSTable(0), testTSTable(ingestPMTPID), testTSPacket(ingestVideoPID, true), testTSPacket(ingestVideoPID, false)}, nil)
	var output []byte
	for _, b := range input {
		data, _, _ := j.feed([]byte{b})
		output = append(output, data...)
	}
	if !bytes.Equal(input, output) || len(j.snapshot()) == 0 {
		t.Fatal("arbitrary read boundaries changed TS data")
	}
	nonkey := testTSPacket(ingestVideoPID, false)
	large := bytes.Repeat(nonkey, ingestGOPMax/tsPacketSize+1)
	j.feed(large)
	if len(j.snapshot()) != 0 || j.size != 0 {
		t.Fatal("over-limit GOP was retained")
	}
	j.feed(testTSPacket(ingestVideoPID, true))
	if len(j.snapshot()) == 0 {
		t.Fatal("cache did not recover at next keyframe")
	}
	j.feed(append([]byte{1, 2, 3}, nonkey...))
	if len(j.snapshot()) != 0 {
		t.Fatal("cache survived lost packet alignment")
	}
}

func TestIngestLateJoinDecodesLongGOP(t *testing.T) {
	bin := ingestFFmpeg(t)
	for _, codec := range []string{"libx264", "libx265"} {
		t.Run(codec, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			path := filepath.Join(t.TempDir(), "long-gop.ts")
			args := []string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "6", "-an", "-c:v", codec, "-preset", "ultrafast", "-g", "100", "-bf", "0", "-threads", "1"}
			if codec == "libx265" {
				args = append(args, "-x265-params", "pools=1:frame-threads=1:scenecut=0:repeat-headers=1")
			} else {
				args = append(args, "-sc_threshold", "0")
			}
			args = append(args, "-f", "mpegts", "-mpegts_start_pid", "256", "-mpegts_pmt_start_pid", "4096", path)
			if out, err := exec.CommandContext(ctx, bin, args...).CombinedOutput(); err != nil {
				t.Fatalf("generate: %v %s", err, out)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			j := &tsJoinCache{}
			// Join halfway through a single, long GOP: its beginning must still be
			// available, even though there has been no recent keyframe.
			cut := len(data) / 2 / tsPacketSize * tsPacketSize
			j.feed(data[:cut])
			pre := j.snapshot()
			if len(pre) == 0 {
				t.Fatal("missing keyframe bootstrap")
			}
			joined := append(bytes.Join(pre, nil), data[cut:]...)
			joinedPath := filepath.Join(t.TempDir(), "joined.ts")
			if err := os.WriteFile(joinedPath, joined, 0600); err != nil {
				t.Fatal(err)
			}
			// Compare every decoded frame, not merely the command's exit status.
			decode := func(input string) []byte {
				cmd := exec.CommandContext(ctx, bin, "-v", "error", "-xerror", "-i", input, "-map", "0:v:0", "-f", "framemd5", "-")
				out, err := cmd.Output()
				if err != nil {
					t.Fatalf("decode %s: %v", codec, err)
				}
				return out
			}
			if !bytes.Equal(decode(path), decode(joinedPath)) {
				t.Fatal("late join changed or lost decoded frames")
			}
		})
	}
}
