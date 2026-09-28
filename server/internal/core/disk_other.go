//go:build !windows

package core

import "syscall"

func diskUsage(path string) (free, total uint64, err error) {
	var st syscall.Statfs_t
	if err = syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	free = st.Bavail * uint64(st.Bsize)
	total = st.Blocks * uint64(st.Bsize)
	return free, total, nil
}
