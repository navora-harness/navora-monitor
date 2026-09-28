//go:build !windows

package core

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func servicePlatformSupported() bool {
	return fileExists("/bin/systemctl") || fileExists("/usr/bin/systemctl")
}

func processElevated() bool {
	return os.Geteuid() == 0
}

func unitPath() string {
	return "/etc/systemd/system/" + strings.ToLower(SystemServiceName) + ".service"
}

func querySystemService() (serviceState, error) {
	if !servicePlatformSupported() {
		return serviceState{}, nil
	}
	installed := fileExists(unitPath())
	if !installed {
		// also accept loaded unit without file we wrote
		out, _ := exec.Command("systemctl", "is-enabled", strings.ToLower(SystemServiceName)).CombinedOutput()
		en := strings.TrimSpace(string(out))
		if en == "enabled" || en == "disabled" || en == "static" {
			installed = true
		}
	}
	st := serviceState{Installed: installed}
	if !installed {
		return st, nil
	}
	out, _ := exec.Command("systemctl", "is-active", strings.ToLower(SystemServiceName)).CombinedOutput()
	st.Running = strings.TrimSpace(string(out)) == "active"
	en, _ := exec.Command("systemctl", "is-enabled", strings.ToLower(SystemServiceName)).CombinedOutput()
	switch strings.TrimSpace(string(en)) {
	case "enabled":
		st.StartType = "auto"
	case "disabled":
		st.StartType = "disabled"
	default:
		st.StartType = "manual"
	}
	if b, err := os.ReadFile(unitPath()); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "ExecStart=") {
				st.BinaryPath = strings.TrimPrefix(line, "ExecStart=")
				break
			}
		}
	}
	return st, nil
}

func installSystemService(exe string, args []string) error {
	if !processElevated() {
		return errStr("注册 systemd 服务需要 root 权限，请用 sudo 运行本程序后再操作")
	}
	cmd := quoteCmd(exe, args)
	unit := fmt.Sprintf(`[Unit]
Description=%s
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s
WorkingDirectory=%s
Restart=on-failure
RestartSec=3
KillMode=control-group

[Install]
WantedBy=multi-user.target
`, SystemServiceDescription, cmd, filepath.Dir(exe))
	path := unitPath()
	if err := os.WriteFile(path, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("写入 unit 失败：%w", err)
	}
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload 失败：%w (%s)", err, strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("systemctl", "enable", strings.ToLower(SystemServiceName)).CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl enable 失败：%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func uninstallSystemService() error {
	if !processElevated() {
		return errStr("移除 systemd 服务需要 root 权限")
	}
	name := strings.ToLower(SystemServiceName)
	_ = exec.Command("systemctl", "stop", name).Run()
	_ = exec.Command("systemctl", "disable", name).Run()
	_ = os.Remove(unitPath())
	_ = exec.Command("systemctl", "daemon-reload").Run()
	return nil
}

func startSystemService(exe string, args []string) error {
	if !processElevated() {
		return errStr("启动服务需要 root 权限")
	}
	_ = exe
	_ = args
	out, err := exec.Command("systemctl", "start", strings.ToLower(SystemServiceName)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("启动失败：%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func stopSystemService() error {
	if !processElevated() {
		return errStr("停止服务需要 root 权限")
	}
	out, err := exec.Command("systemctl", "stop", strings.ToLower(SystemServiceName)).CombinedOutput()
	if err != nil {
		return fmt.Errorf("停止失败：%w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
