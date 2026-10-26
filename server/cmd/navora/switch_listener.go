package main

import (
	"fmt"
	"net"
	"sync"
)

// Replacing only the listening socket leaves established HTTP connections and
// media workers alive. Accept waits for the replacement under the same mutex.
type switchListener struct {
	mu      sync.Mutex
	current net.Listener
	closed  bool
}

func (l *switchListener) Accept() (net.Conn, error) {
	for {
		l.mu.Lock()
		if l.closed {
			l.mu.Unlock()
			return nil, net.ErrClosed
		}
		current := l.current
		l.mu.Unlock()
		conn, err := current.Accept()
		if err == nil {
			return conn, nil
		}
		l.mu.Lock()
		replaced := current != l.current && !l.closed
		l.mu.Unlock()
		if !replaced {
			return nil, err
		}
	}
}

func (l *switchListener) Addr() net.Addr {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.current.Addr()
}

func (l *switchListener) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closed = true
	return l.current.Close()
}

func (l *switchListener) replace(address string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return net.ErrClosed
	}
	previous := l.current.Addr().String()
	if previous == address {
		return nil
	}
	_ = l.current.Close()
	next, err := net.Listen("tcp", address)
	if err != nil {
		restored, restoreErr := net.Listen("tcp", previous)
		if restoreErr != nil {
			l.closed = true
			return fmt.Errorf("%w; 恢复监听失败: %v", err, restoreErr)
		}
		l.current = restored
		return err
	}
	l.current = next
	return nil
}
