package core

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	SystemServiceName        = "NavoraMonitor"
	SystemServiceDisplayName = "Navora Monitor"
	SystemServiceDescription = "Navora Monitor — LAN CCTV preview, recording, and playback"
)

// SystemServiceInfo is returned to the settings UI.
type SystemServiceInfo struct {
	Supported bool   `json:"supported"`
	Platform  string `json:"platform"`
	Name      string `json:"name"`
	Display   string `json:"display"`
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	StartType string `json:"startType,omitempty"` // auto | manual | disabled | ""
	ExePath   string `json:"exePath,omitempty"`
	DataPath  string `json:"dataPath,omitempty"`
	Command   string `json:"command,omitempty"`
	Elevated  bool   `json:"elevated"` // true when current process likely has rights to manage services
	Message   string `json:"message,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (c *Core) SystemServiceStatus() SystemServiceInfo {
	info := SystemServiceInfo{
		Platform: runtime.GOOS,
		Name:     SystemServiceName,
		Display:  SystemServiceDisplayName,
		DataPath: c.root,
		Elevated: processElevated(),
	}
	exe, args, err := c.serviceCommandLine()
	if err != nil {
		info.Error = err.Error()
		info.Supported = servicePlatformSupported()
		return info
	}
	info.ExePath = exe
	info.Command = quoteCmd(exe, args)
	info.Supported = servicePlatformSupported()
	if !info.Supported {
		info.Message = "当前系统暂不支持以系统服务方式安装"
		return info
	}
	st, err := querySystemService()
	if err != nil {
		info.Error = err.Error()
		return info
	}
	info.Installed = st.Installed
	info.Running = st.Running
	info.StartType = st.StartType
	if st.BinaryPath != "" {
		info.Command = st.BinaryPath
	}
	if !info.Elevated && !info.Installed {
		info.Message = "注册或移除系统服务需要管理员权限，请以管理员身份运行本程序后再操作"
	}
	return info
}

func (c *Core) SystemServiceAction(action string) SystemServiceInfo {
	action = strings.ToLower(strings.TrimSpace(action))
	info := c.SystemServiceStatus()
	if !info.Supported {
		info.Error = "不支持的系统"
		return info
	}
	exe, args, err := c.serviceCommandLine()
	if err != nil {
		info.Error = err.Error()
		return info
	}
	switch action {
	case "install", "register":
		if err := installSystemService(exe, args); err != nil {
			info.Error = err.Error()
			return c.mergeServiceAction(info)
		}
		info = c.SystemServiceStatus()
		info.Message = "已注册/更新系统服务（开机自启）。若当前仍在命令行运行，请先退出程序，再点「启动」。"
		return info
	case "uninstall", "remove":
		if err := uninstallSystemService(); err != nil {
			info.Error = err.Error()
			return c.mergeServiceAction(info)
		}
		info = c.SystemServiceStatus()
		info.Message = "已移除系统服务"
		return info
	case "start":
		if err := startSystemService(exe, args); err != nil {
			info.Error = err.Error()
			return c.mergeServiceAction(info)
		}
		info = c.SystemServiceStatus()
		info.Message = "服务已启动"
		return info
	case "stop":
		if err := stopSystemService(); err != nil {
			info.Error = err.Error()
			return c.mergeServiceAction(info)
		}
		info = c.SystemServiceStatus()
		info.Message = "服务已停止"
		return info
	case "restart":
		_ = stopSystemService()
		if err := startSystemService(exe, args); err != nil {
			info.Error = err.Error()
			return c.mergeServiceAction(info)
		}
		info = c.SystemServiceStatus()
		info.Message = "服务已重启"
		return info
	default:
		info.Error = "未知操作"
		return info
	}
}

func (c *Core) mergeServiceAction(partial SystemServiceInfo) SystemServiceInfo {
	next := c.SystemServiceStatus()
	if partial.Error != "" {
		next.Error = partial.Error
	}
	if partial.Message != "" {
		next.Message = partial.Message
	}
	return next
}

func (c *Core) serviceCommandLine() (exe string, args []string, err error) {
	exe, err = os.Executable()
	if err != nil {
		return "", nil, err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return "", nil, err
	}
	if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil && resolved != "" {
		exe = resolved
	}
	if strings.Contains(filepath.ToSlash(exe), "/go-build") {
		return "", nil, errStr("当前是 go run 临时进程，无法注册为系统服务。请先打包或使用正式 navora 可执行文件运行后再注册")
	}
	data, err := filepath.Abs(c.root)
	if err != nil {
		return "", nil, err
	}
	return exe, []string{"--data", data}, nil
}

func quoteCmd(exe string, args []string) string {
	parts := make([]string, 0, 1+len(args))
	parts = append(parts, quoteArg(exe))
	for _, a := range args {
		parts = append(parts, quoteArg(a))
	}
	return strings.Join(parts, " ")
}

func quoteArg(s string) string {
	if s == "" {
		return `""`
	}
	if !strings.ContainsAny(s, " \t\"") {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

type serviceState struct {
	Installed  bool
	Running    bool
	StartType  string
	BinaryPath string
}
