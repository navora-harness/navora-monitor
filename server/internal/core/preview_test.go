package core

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLivePipeDeliversEveryChunk(t *testing.T) {
	pipe := newLivePipe()
	rec := httptest.NewRecorder()
	client := &liveClient{w: rec, rc: http.NewResponseController(rec), done: make(chan struct{})}
	if !pipe.add(client) {
		t.Fatal("pipe closed")
	}
	var want []byte
	for i := 0; i < 200; i++ {
		b := []byte{byte(i), byte(i >> 8)}
		want = append(want, b...)
		pipe.publish(b)
	}
	if got := rec.Body.Bytes(); string(got) != string(want) {
		t.Fatalf("dropped or reordered bytes: got %d want %d", len(got), len(want))
	}
	if pipe.count() != 1 {
		t.Fatal("subscriber missing")
	}
	pipe.close()
	select {
	case <-client.done:
	case <-time.After(time.Second):
		t.Fatal("close did not finish client")
	}
}

func TestLivePipePreambleForLateClient(t *testing.T) {
	pipe := newLivePipe()
	pipe.publish([]byte("pat"))
	rec := httptest.NewRecorder()
	client := &liveClient{w: rec, rc: http.NewResponseController(rec), done: make(chan struct{})}
	pre := pipe.preamble()
	for _, b := range pre {
		if err := client.write(b); err != nil {
			t.Fatal(err)
		}
	}
	if !pipe.add(client) {
		t.Fatal("pipe closed")
	}
	pipe.publish([]byte("next"))
	if got := rec.Body.String(); got != "patnext" {
		t.Fatalf("got %q", got)
	}
}
