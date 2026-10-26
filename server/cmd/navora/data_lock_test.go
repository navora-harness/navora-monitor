package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDataLockRejectsDuplicateAndAllowsIndependentRoot(t *testing.T) {
	root := t.TempDir()
	release, err := acquireDataLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if other, err := acquireDataLock(filepath.Join(root, ".")); err == nil {
		other()
		t.Fatal("duplicate data directory was accepted")
	}
	independent, err := acquireDataLock(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	independent()
	if err := initializeData(root, true); err == nil {
		t.Fatal("password reset bypassed instance lock")
	}
	if err := runConsole(root, "127.0.0.1", 0, true); err == nil {
		t.Fatal("console bypassed instance lock")
	}
	if _, err := os.Stat(filepath.Join(root, "auth.json")); !os.IsNotExist(err) {
		t.Fatal("blocked initialization modified authentication")
	}
	release()
	release()
	reopened, err := acquireDataLock(root)
	if err != nil {
		t.Fatal(err)
	}
	reopened()
}

func TestDataLockProcessHelper(t *testing.T) {
	root := os.Getenv("NAVORA_TEST_LOCK_ROOT")
	if root == "" {
		return
	}
	release, err := acquireDataLock(root)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	fmt.Println("locked")
	time.Sleep(time.Minute)
}

func TestDataLockIsReleasedAfterProcessTermination(t *testing.T) {
	root := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestDataLockProcessHelper$")
	cmd.Env = append(os.Environ(), "NAVORA_TEST_LOCK_ROOT="+root)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if line != "locked\n" && line != "locked\r\n" {
			t.Fatalf("child did not acquire lock: %q", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("lock helper did not start")
	}
	if release, err := acquireDataLock(root); err == nil {
		release()
		t.Fatal("another process bypassed lock")
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	release, err := acquireDataLock(root)
	if err != nil {
		t.Fatalf("stale lock after process termination: %v", err)
	}
	release()
}
