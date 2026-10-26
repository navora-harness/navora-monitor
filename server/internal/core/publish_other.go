//go:build !windows

package core

import "os"

func replaceFile(src, dst string) error { return os.Rename(src, dst) }

func publishNew(src, dst string) error {
	if err := os.Link(src, dst); err != nil {
		return err
	}
	// The destination is safely published even if temporary-file cleanup fails.
	_ = os.Remove(src)
	return nil
}
