package core

import (
	"context"
	"fmt"
	"os"
	"sync/atomic"
)

type playbackJob struct {
	priority atomic.Int32
	done     chan struct{}
	cancel   context.CancelFunc
	waiters  int
	path     string
	err      error
}
type playbackH264Key struct{}

// Concurrent viewers share one conversion. Cancelling one viewer only cancels
// the job when its last subscriber leaves. The queue has a hard upper bound.
func (c *Core) prepareShared(ctx context.Context, kind, id, name string) (string, error) {
	return c.prepareSharedPriority(ctx, kind, id, name, false)
}

func (c *Core) prepareSharedPriority(ctx context.Context, kind, id, name string, prefetch bool) (string, error) {
	return c.prepareSharedCodec(ctx, kind, id, name, prefetch, false)
}

func (c *Core) prepareSharedCodec(ctx context.Context, kind, id, name string, prefetch, h264 bool) (string, error) {
	source, err := c.resolveMedia(kind, id, name)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(source)
	if err != nil {
		return "", err
	}
	key := fmt.Sprintf("%s:%d:%d:%t", source, info.Size(), info.ModTime().UnixNano(), h264)
	m := c.media
	m.jobsMu.Lock()
	if m.jobs == nil {
		m.jobs = map[string]*playbackJob{}
	}
	job := m.jobs[key]
	if job == nil {
		if prefetch {
			background := 0
			for _, pending := range m.jobs {
				if pending.priority.Load() > 0 {
					background++
				}
			}
			if background >= 8 {
				m.jobsMu.Unlock()
				return "", errStr("预加载任务较多，稍后重试")
			}
		}
		if len(m.jobs) >= 32 {
			m.jobsMu.Unlock()
			return "", errStr("回放准备任务较多，请稍后重试")
		}
		jobCtx, cancel := context.WithCancel(context.Background())
		job = &playbackJob{done: make(chan struct{}), cancel: cancel}
		if prefetch {
			job.priority.Store(2)
		}
		jobCtx = withMediaPriority(jobCtx, &job.priority)
		jobCtx = context.WithValue(jobCtx, playbackH264Key{}, h264)
		m.jobs[key] = job
		go func() {
			job.path, job.err = c.ensurePlayableContext(jobCtx, kind, id, name)
			close(job.done)
			m.jobsMu.Lock()
			if m.jobs[key] == job {
				delete(m.jobs, key)
			}
			m.jobsMu.Unlock()
			cancel()
		}()
	}
	if !prefetch {
		job.priority.Store(0)
		m.work.mu.Lock()
		m.work.dispatch()
		m.work.mu.Unlock()
	}
	job.waiters++
	m.jobsMu.Unlock()
	defer func() {
		m.jobsMu.Lock()
		job.waiters--
		if job.waiters == 0 {
			job.cancel()
			if m.jobs[key] == job {
				delete(m.jobs, key)
			}
		}
		m.jobsMu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-job.done:
		return job.path, job.err
	}
}
