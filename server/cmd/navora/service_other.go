//go:build !windows

package main

func maybeRunWindowsService() bool { return false }
