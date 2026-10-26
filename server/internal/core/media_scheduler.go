package core

import (
	"context"
	"sync"
	"sync/atomic"
)

type mediaPriorityKey struct{}

// 0: current playback; 1: export; 2: speculative preload / metadata.
func withMediaPriority(ctx context.Context, priority *atomic.Int32) context.Context {
	return context.WithValue(ctx, mediaPriorityKey{}, priority)
}

func backgroundMediaContext(ctx context.Context, level int32) context.Context {
	priority := &atomic.Int32{}
	priority.Store(level)
	return withMediaPriority(ctx, priority)
}

type mediaWaiter struct {
	ctx        context.Context
	ready      chan struct{}
	granted    bool
	background bool
}

func (w *mediaWaiter) priority() int32 {
	if priority, ok := w.ctx.Value(mediaPriorityKey{}).(*atomic.Int32); ok {
		return priority.Load()
	}
	return 0
}

// At most two heavy file operations, with one slot reserved for playback.
// Export, preload and metadata share a single background slot.
// Running operations finish normally; cancelled queued work never starts.
type mediaScheduler struct {
	mu         sync.Mutex
	active     int
	background int
	queue      []*mediaWaiter
}

func (s *mediaScheduler) acquire(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	w := &mediaWaiter{ctx: ctx, ready: make(chan struct{})}
	s.mu.Lock()
	s.queue = append(s.queue, w)
	s.dispatch()
	s.mu.Unlock()
	select {
	case <-w.ready:
		if err := ctx.Err(); err != nil {
			s.release(w)
			return nil, err
		}
		var once sync.Once
		return func() { once.Do(func() { s.release(w) }) }, nil
	case <-ctx.Done():
		s.mu.Lock()
		for i, queued := range s.queue {
			if queued == w {
				s.queue = append(s.queue[:i], s.queue[i+1:]...)
				s.mu.Unlock()
				return nil, ctx.Err()
			}
		}
		granted := w.granted
		s.mu.Unlock()
		// Dispatch raced with cancellation: return the granted slot.
		if granted {
			s.release(w)
		}
		return nil, ctx.Err()
	}
}

func (s *mediaScheduler) release(w *mediaWaiter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.active--
	if w.background {
		s.background--
	}
	s.dispatch()
}

// Caller holds mu; priority can be promoted while a shared preload is queued.
func (s *mediaScheduler) dispatch() {
	for s.active < 2 {
		best := -1
		for i, w := range s.queue {
			if w.ctx.Err() != nil || (w.priority() > 0 && s.background >= 1) {
				continue
			}
			if best < 0 || w.priority() < s.queue[best].priority() {
				best = i
			}
		}
		if best < 0 {
			return
		}
		w := s.queue[best]
		s.queue = append(s.queue[:best], s.queue[best+1:]...)
		w.granted = true
		w.background = w.priority() > 0
		s.active++
		if w.background {
			s.background++
		}
		close(w.ready)
	}
}

func (s *mediaScheduler) run(ctx context.Context, fn func() error) error {
	release, err := s.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	return fn()
}
