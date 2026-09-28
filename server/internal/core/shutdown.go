package core

import (
	"log"
	"os"
	"time"
)

func (c *Core) initShutdown() {
	c.shutdownCh = make(chan struct{})
}

// ShutdownNotify is closed once when an admin requests process exit.
func (c *Core) ShutdownNotify() <-chan struct{} {
	return c.shutdownCh
}

// RequestShutdown asks the main process to stop HTTP, media children, then exit.
func (c *Core) RequestShutdown() {
	c.shutdownOnce.Do(func() {
		log.Printf("shutdown requested")
		close(c.shutdownCh)
	})
}

// StopAllMedia stops preview and recording FFmpeg (including adopted recorders).
func (c *Core) StopAllMedia() {
	c.rec.stopAll()
	for id, pids := range recordingFfmpegByChannel() {
		for _, pid := range pids {
			if !processAlive(pid) {
				continue
			}
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
				log.Printf("shutdown killed recording ffmpeg %s pid=%d", id, pid)
			}
		}
	}
	c.prev.stopAll()
}

func (p *previewMgr) stopAll() {
	p.mu.Lock()
	ids := make([]string, 0, len(p.sess))
	for id := range p.sess {
		ids = append(ids, id)
	}
	p.mu.Unlock()
	for _, id := range ids {
		p.stop(id)
	}
}

// ShutdownGrace briefs so in-flight HTTP can flush before the listener closes.
func (c *Core) ShutdownGrace(d time.Duration) {
	if d <= 0 {
		d = 500 * time.Millisecond
	}
	time.Sleep(d)
}
