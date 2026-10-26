package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// The persistent lock file must not be removed: unlinking it could let another
// process lock a different file at the same path while this handle is alive.
func acquireDataLock(root string) (func(), error) {
	if err := os.MkdirAll(root, 0755); err != nil {
		return nil, err
	}
	file, err := openDataLock(filepath.Join(root, ".navora-instance.lock"))
	if err != nil {
		return nil, fmt.Errorf("无法独占数据目录 %s：可能已有程序或系统服务运行，或目录权限不足；请先退出已有实例：%w", root, err)
	}
	var once sync.Once
	return func() { once.Do(func() { _ = file.Close() }) }, nil
}
