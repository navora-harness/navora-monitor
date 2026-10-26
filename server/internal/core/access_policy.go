package core

import (
	"net"
	"strings"
	"time"
)

type loginWindow struct {
	at       time.Time
	attempts int
}

func (c *Core) allowLogin(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loginWindows == nil {
		c.loginWindows = map[string]loginWindow{}
	}
	now := time.Now()
	for ip, window := range c.loginWindows {
		if now.Sub(window.at) >= time.Minute {
			delete(c.loginWindows, ip)
		}
	}
	w := c.loginWindows[host]
	if w.at.IsZero() {
		if len(c.loginWindows) >= 1024 {
			return false
		}
		w.at = now
	}
	w.attempts++
	c.loginWindows[host] = w
	return w.attempts <= 10
}

func loopbackRequest(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func (c *Core) revokeSessionLocked(token string) {
	if session := c.sessions[token]; session != nil && session.done != nil {
		close(session.done)
	}
	delete(c.sessions, token)
}

// The setting wins over an explicit --addr while remote access is disabled.
func ListenHost(explicit string, remoteEnabled bool) string {
	if !remoteEnabled {
		return "127.0.0.1"
	}
	if explicit != "" {
		return explicit
	}
	return "0.0.0.0"
}
