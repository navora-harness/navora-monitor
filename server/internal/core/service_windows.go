//go:build windows

package core

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func servicePlatformSupported() bool { return true }

func processElevated() bool {
	var token windows.Token
	err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token)
	if err != nil {
		return false
	}
	defer token.Close()
	return token.IsElevated()
}

func querySystemService() (serviceState, error) {
	m, err := mgr.Connect()
	if err != nil {
		return serviceState{}, fmt.Errorf("无法连接服务控制管理器：%w（需要管理员权限）", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(SystemServiceName)
	if err != nil {
		return serviceState{}, nil // not installed
	}
	defer s.Close()
	cfg, err := s.Config()
	if err != nil {
		return serviceState{}, err
	}
	st, err := s.Query()
	if err != nil {
		return serviceState{}, err
	}
	startType := "manual"
	switch cfg.StartType {
	case mgr.StartAutomatic:
		startType = "auto"
	case mgr.StartDisabled:
		startType = "disabled"
	case mgr.StartManual:
		startType = "manual"
	}
	return serviceState{
		Installed:  true,
		Running:    st.State == svc.Running || st.State == svc.StartPending,
		StartType:  startType,
		BinaryPath: cfg.BinaryPathName,
	}, nil
}

// serviceImagePath builds ImagePath the same way mgr.CreateService does
// (EscapeArg on bare exe + each arg). Never pass an already-quoted command line
// as exepath — CreateService would EscapeArg it again and break the path.
func serviceImagePath(exe string, args []string) string {
	s := syscall.EscapeArg(exe)
	for _, a := range args {
		s += " " + syscall.EscapeArg(a)
	}
	return s
}

func installSystemService(exe string, args []string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("无法连接服务控制管理器：%w（请以管理员身份运行）", err)
	}
	defer m.Disconnect()
	if s, err := m.OpenService(SystemServiceName); err == nil {
		// Already registered: repair ImagePath to current exe (fixes older broken installs).
		defer s.Close()
		if err := updateServiceImage(s, exe, args); err != nil {
			return fmt.Errorf("服务已存在，更新路径失败：%w", err)
		}
		return nil
	}
	s, err := m.CreateService(
		SystemServiceName,
		exe,
		mgr.Config{
			StartType:   mgr.StartAutomatic,
			DisplayName: SystemServiceDisplayName,
			Description: SystemServiceDescription,
		},
		args...,
	)
	if err != nil {
		return fmt.Errorf("注册失败：%w", err)
	}
	defer s.Close()
	return nil
}

func updateServiceImage(s *mgr.Service, exe string, args []string) error {
	cfg, err := s.Config()
	if err != nil {
		return err
	}
	cfg.BinaryPathName = serviceImagePath(exe, args)
	cfg.DisplayName = SystemServiceDisplayName
	cfg.Description = SystemServiceDescription
	if cfg.StartType == 0 {
		cfg.StartType = mgr.StartAutomatic
	}
	return s.UpdateConfig(cfg)
}

func uninstallSystemService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("无法连接服务控制管理器：%w（请以管理员身份运行）", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(SystemServiceName)
	if err != nil {
		return errStr("服务未安装")
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	waitServiceState(s, svc.Stopped, 12*time.Second)
	if err := s.Delete(); err != nil {
		return fmt.Errorf("移除失败：%w", err)
	}
	return nil
}

func startSystemService(exe string, args []string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("无法连接服务控制管理器：%w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(SystemServiceName)
	if err != nil {
		return errStr("服务未安装")
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	switch st.State {
	case svc.Running, svc.StartPending:
		return waitServiceState(s, svc.Running, 20*time.Second)
	case svc.StopPending:
		if err := waitServiceState(s, svc.Stopped, 20*time.Second); err != nil {
			return err
		}
	}

	// Heal broken ImagePath from older builds (DisplayName / double-quoted cmdline).
	if exe != "" {
		if cfg, err := s.Config(); err == nil {
			want := serviceImagePath(exe, args)
			if cfg.BinaryPathName != want || !serviceImageLooksValid(cfg.BinaryPathName) {
				_ = updateServiceImage(s, exe, args)
			}
		}
	}

	if err := s.Start(); err != nil {
		if isFileNotFound(err) && exe != "" {
			if uerr := updateServiceImage(s, exe, args); uerr == nil {
				if err2 := s.Start(); err2 == nil {
					return waitServiceState(s, svc.Running, 20*time.Second)
				} else {
					err = err2
				}
			}
		}
		if isFileNotFound(err) {
			return errStr("启动失败：服务镜像路径无效。请先「移除」再「注册」，或确认可执行文件仍在原路径（" + exe + "）")
		}
		return fmt.Errorf("启动失败：%w（若命令行实例仍在运行，请先退出程序）", err)
	}
	return waitServiceState(s, svc.Running, 20*time.Second)
}

func serviceImageLooksValid(image string) bool {
	image = strings.TrimSpace(image)
	if image == "" {
		return false
	}
	// Bare display name mistakenly used as path in an early build.
	if !strings.Contains(image, `\`) && !strings.Contains(image, `/`) {
		return false
	}
	path := image
	if strings.HasPrefix(path, `"`) {
		if i := strings.Index(path[1:], `"`); i >= 0 {
			path = path[1 : 1+i]
		}
	} else if i := strings.IndexAny(path, " \t"); i >= 0 {
		path = path[:i]
	}
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func isFileNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "cannot find the file") || strings.Contains(msg, "系统找不到指定的文件")
}

func stopSystemService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("无法连接服务控制管理器：%w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(SystemServiceName)
	if err != nil {
		return errStr("服务未安装")
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("停止失败：%w", err)
	}
	return waitServiceState(s, svc.Stopped, 20*time.Second)
}

func waitServiceState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return errStr("等待服务状态超时")
}
