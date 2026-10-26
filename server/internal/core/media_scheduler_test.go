package core

import (
	"context"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func awaitQueued(t *testing.T, scheduler *mediaScheduler, count int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		scheduler.mu.Lock()
		n := len(scheduler.queue)
		scheduler.mu.Unlock()
		if n == count {
			return
		}
		runtime.Gosched()
	}
	t.Fatal("scheduler did not queue work")
}

func TestMediaSchedulerReservesPlaybackAndPrioritizesQueue(t *testing.T) {
	var scheduler mediaScheduler
	background, err := scheduler.acquire(backgroundMediaContext(context.Background(), 2))
	if err != nil {
		t.Fatal(err)
	}
	playback, err := scheduler.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(background)
	t.Cleanup(playback)
	order := make(chan string, 2)
	finish := make(chan struct{})
	t.Cleanup(func() { close(finish) })
	go scheduler.run(backgroundMediaContext(context.Background(), 2), func() error { order <- "preload"; <-finish; return nil })
	awaitQueued(t, &scheduler, 1)
	go scheduler.run(context.Background(), func() error { order <- "playback"; <-finish; return nil })
	awaitQueued(t, &scheduler, 2)
	playback()
	select {
	case name := <-order:
		if name != "playback" {
			t.Fatal(name)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("playback blocked")
	}
	background()
	select {
	case name := <-order:
		if name != "preload" {
			t.Fatal(name)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("preload blocked")
	}
}

func TestMediaSchedulerPromotesSharedPreload(t *testing.T) {
	var scheduler mediaScheduler
	release, _ := scheduler.acquire(backgroundMediaContext(context.Background(), 2))
	defer release()
	priority := &atomic.Int32{}
	priority.Store(2)
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- scheduler.run(withMediaPriority(context.Background(), priority), func() error { close(started); return nil })
	}()
	awaitQueued(t, &scheduler, 1)
	priority.Store(0)
	scheduler.mu.Lock()
	scheduler.dispatch()
	scheduler.mu.Unlock()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("promoted playback did not use reserved slot")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMediaSchedulerCancellationDoesNotConsumeSlots(t *testing.T) {
	for i := 0; i < 100; i++ {
		var scheduler mediaScheduler
		first, _ := scheduler.acquire(context.Background())
		second, _ := scheduler.acquire(context.Background())
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- scheduler.run(ctx, func() error { return ctx.Err() }) }()
		awaitQueued(t, &scheduler, 1)
		cancel()
		first()
		second()
		if err := <-done; err != context.Canceled {
			t.Fatalf("unexpected cancellation: %v", err)
		}
		one, err := scheduler.acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		two, err := scheduler.acquire(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		one()
		two()
		scheduler.mu.Lock()
		active := scheduler.active
		scheduler.mu.Unlock()
		if active != 0 {
			t.Fatalf("leaked or double released slot: %d", active)
		}
	}
}
