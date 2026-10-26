package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

type rotatingLog struct {
	mu     sync.Mutex
	path   string
	limit  int64
	file   *os.File
	size   int64
	closed bool
}

func newRotatingLog(path string, limit int64) (*rotatingLog, error) {
	if limit < 1 {
		return nil, errors.New("日志大小上限必须为正数")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	w := &rotatingLog{path: path, limit: limit}
	if err := w.open(); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *rotatingLog) open() error {
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return err
	}
	w.file, w.size = file, info.Size()
	return nil
}

func (w *rotatingLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, io.ErrClosedPipe
	}
	original := len(p)
	if int64(len(p)) > w.limit {
		p = p[len(p)-int(w.limit):]
	}
	if w.file == nil {
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	if w.size > 0 && w.size+int64(len(p)) > w.limit {
		err := w.file.Close()
		w.file = nil
		if err != nil {
			return 0, err
		}
		if err := os.Remove(w.path + ".1"); err != nil && !os.IsNotExist(err) {
			return 0, err
		}
		if err := os.Rename(w.path, w.path+".1"); err != nil {
			return 0, err
		}
		if err := w.open(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	if err != nil {
		return n, err
	}
	return original, nil
}

func (w *rotatingLog) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
