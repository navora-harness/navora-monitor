package core

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type observedWaitContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *observedWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func TestMovingFileWaitCanBeCanceledWithoutLeakingReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "moving.ts")
	key := leaseKey(path)
	leases := fileLeases{moving: map[string]bool{key: true}, changed: make(chan struct{})}
	base, cancel := context.WithCancel(context.Background())
	ctx := &observedWaitContext{Context: base, entered: make(chan struct{})}
	defer cancel()
	done := make(chan error, 1)
	go func() {
		release, err := leases.acquireContext(ctx, path)
		if release != nil {
			release()
		}
		done <- err
	}()
	select {
	case <-ctx.entered:
	case <-time.After(time.Second):
		t.Fatal("reader did not wait for moving file")
	}
	// A move on this path must not block an unrelated recording.
	other, err := leases.acquireContext(context.Background(), path+"-other")
	if err != nil {
		t.Fatal(err)
	}
	other()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled request still waiting for move")
	}
	leases.mu.Lock()
	defer leases.mu.Unlock()
	if len(leases.readers) != 0 {
		t.Fatalf("reader leaked: %v", leases.readers)
	}
}

func TestMoveCompletionWakesWaitingReader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "moving.ts")
	key := leaseKey(path)
	leases := fileLeases{moving: map[string]bool{key: true}, changed: make(chan struct{})}
	base, cancel := context.WithTimeout(context.Background(), time.Second)
	ctx := &observedWaitContext{Context: base, entered: make(chan struct{})}
	defer cancel()
	done := make(chan error, 1)
	go func() {
		release, err := leases.acquireContext(ctx, path)
		if release != nil {
			release()
			release()
		}
		done <- err
	}()
	select {
	case <-ctx.entered:
	case <-time.After(time.Second):
		t.Fatal("reader did not wait for moving file")
	}
	leases.mu.Lock()
	delete(leases.moving, key)
	close(leases.changed)
	leases.changed = make(chan struct{})
	leases.mu.Unlock()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	leases.mu.Lock()
	defer leases.mu.Unlock()
	if len(leases.readers) != 0 {
		t.Fatalf("reader leaked: %v", leases.readers)
	}
}

func TestCanceledRequestDoesNotAcquireFreeFile(t *testing.T) {
	var leases fileLeases
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	release, err := leases.acquireContext(ctx, filepath.Join(t.TempDir(), "ready.ts"))
	if release != nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request acquired a reader: %v", err)
	}
}

func TestExportCancellationWhileWaitingReleasesEarlierSources(t *testing.T) {
	c := isolatedCore(t)
	dir := c.channelRecordDir("test")
	for _, name := range []string{"test-20261012-100000.ts", "test-20261012-100010.ts"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, make([]byte, 1024), 0600); err != nil {
			t.Fatal(err)
		}
		old := time.Date(2026, 10, 12, 10, 5, 0, 0, time.Local)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	segments := segmentsOverlapping(c.timed("test"), 0, time.Date(2026, 10, 13, 0, 0, 0, 0, time.Local).UnixMilli())
	if len(segments) != 2 {
		t.Fatalf("unexpected source selection: %d", len(segments))
	}
	first, second := leaseKey(segments[0].Path), leaseKey(segments[1].Path)
	c.media.leases.moving = map[string]bool{second: true}
	c.media.leases.changed = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := c.ExportRangeContext(ctx, "test", segments[0].StartMs, segments[1].EndMs, "")
		done <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		c.media.leases.mu.Lock()
		hasFirst := c.media.leases.readers[first] == 1
		c.media.leases.mu.Unlock()
		if hasFirst {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("export did not reserve first source")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("export is still waiting on move")
	}
	c.media.leases.mu.Lock()
	defer c.media.leases.mu.Unlock()
	if len(c.media.leases.readers) != 0 || len(c.media.exportSlots) != 0 {
		t.Fatal("canceled export retained sources or task slot")
	}
}
