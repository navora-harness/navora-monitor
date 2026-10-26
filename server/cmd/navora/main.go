package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/navora-harness/navora-monitor/server/internal/core"
)

func main() {
	enableUTF8()
	if maybeRunWindowsService() {
		return
	}

	data := flag.String("data", "", "配置目录（默认 portable/ 或 NAVORA_MONITOR_DATA_ROOT）")
	port := flag.Int("port", 0, "监听端口，0 表示使用设置中的端口")
	addr := flag.String("addr", "", "远程启用时的监听地址")
	reset := flag.Bool("reset-password", false, "重新生成管理员密码并打印")
	initialize := flag.Bool("init-only", false, "仅初始化配置与管理员账户，然后退出")
	flag.Parse()
	if *initialize {
		if err := initializeData(*data, *reset); err != nil {
			log.Fatal(err)
		}
		return
	}

	if err := runConsole(*data, *addr, *port, *reset); err != nil {
		log.Fatal(err)
	}
}

func initializeData(dataFlag string, reset bool) error {
	root := resolveData(dataFlag)
	release, err := acquireDataLock(root)
	if err != nil {
		return err
	}
	defer release()
	app, err := core.Open(root)
	if err != nil {
		return err
	}
	pw, created, migrated, err := app.EnsurePassword(reset)
	if err != nil {
		return err
	}
	fmt.Println("管理员账户:", app.Settings().RemoteUsername)
	if created || reset {
		fmt.Println("初始密码（仅显示一次）:", pw)
	} else if migrated {
		fmt.Println("已保留原管理员密码")
	} else {
		fmt.Println("账户已初始化，保留现有密码")
	}
	return nil
}

func runConsole(dataFlag, addr string, port int, reset bool) error {
	root := resolveData(dataFlag)
	release, err := acquireDataLock(root)
	if err != nil {
		return err
	}
	defer release()
	app, err := core.Open(root)
	if err != nil {
		return fmt.Errorf("无法打开数据目录 %s: %w", root, err)
	}
	pw, created, migrated, err := app.EnsurePassword(reset)
	if err != nil {
		return fmt.Errorf("初始化管理员密码失败: %w", err)
	}
	settings := app.Settings()
	listenPort := settings.RemotePort
	if port != 0 {
		listenPort = port
	}
	host := core.ListenHost(addr, true)
	urls := []string{}
	if settings.RemoteEnabled {
		urls = lanURLs(listenPort)
	}
	app.SetListen(listenPort, urls)

	fmt.Println("========================================")
	fmt.Println("Navora Monitor", core.Version)
	fmt.Println("配置目录:", root)
	fmt.Println("管理员账户:", settings.RemoteUsername)
	switch {
	case created:
		fmt.Println("初始密码:", pw)
		fmt.Println("此密码只显示这一次。忘记密码时请用 --reset-password 重新生成。")
	case migrated:
		fmt.Println("已使用配置中的现有管理员密码（不在日志中显示）。")
	case reset:
		fmt.Println("新密码:", pw)
		fmt.Println("此密码只显示这一次。")
	default:
		fmt.Println("密码已设置。忘记密码时请用 --reset-password 重新生成。")
	}
	fmt.Println("本机: http://127.0.0.1:" + itoa(listenPort) + "/")
	for _, u := range urls {
		fmt.Println("局域网:", u)
	}
	fmt.Println("开发界面可另开 npm run dev ，浏览器打开 http://127.0.0.1:5188")
	fmt.Println("========================================")

	return serveHTTP(app, host, listenPort)
}

func serveHTTP(app *core.Core, host string, listenPort int) error {
	return serveHTTPReady(app, host, listenPort, nil)
}

func serveHTTPReady(app *core.Core, host string, listenPort int, ready chan<- struct{}) error {
	ln, err := net.Listen("tcp", core.ListenAddr(core.ListenHost(host, app.Settings().RemoteEnabled), listenPort))
	if err != nil {
		return fmt.Errorf("监听失败: %w", err)
	}
	switchable := &switchListener{current: ln}
	app.SetListenAddress(func() string { return switchable.Addr().String() })
	app.SetRemoteSwitch(func(enabled bool) error {
		return switchable.replace(core.ListenAddr(core.ListenHost(host, enabled), listenPort))
	})
	app.SetListen(listenPort, lanURLs(listenPort))
	srv := &http.Server{
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	// Do not adopt/resume recorders until this instance owns its HTTP port.
	go app.RunLoops()
	log.Printf("listening on %s", ln.Addr())
	if ready != nil {
		close(ready)
	}
	return serveHTTPServer(app, switchable, srv)
}

func serveHTTPServer(app *core.Core, ln net.Listener, srv *http.Server) error {
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-app.ShutdownNotify()
		app.ShutdownGrace(400 * time.Millisecond)
		app.StopAllMedia()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			_ = srv.Close()
		}
		log.Printf("exited")
		// Do not os.Exit here: Windows service Execute must return to SCM,
		// and console main exits cleanly once Serve returns.
	}()
	err := srv.Serve(ln)
	app.RequestShutdown()
	// Serve returns as soon as Shutdown closes the listener, before active
	// handlers finish. Keep the process alive until cleanup actually completes.
	<-stopped
	if err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func resolveData(flagPath string) string {
	if flagPath != "" {
		return flagPath
	}
	if env := os.Getenv("NAVORA_MONITOR_DATA_ROOT"); env != "" {
		return env
	}
	cwd, _ := os.Getwd()
	var cands []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if !strings.Contains(dir, "go-build") {
			cands = append(cands, filepath.Join(dir, "portable"))
		}
	}
	cands = append(cands,
		filepath.Join(cwd, "portable"),
		filepath.Join(cwd, "..", "portable"),
	)
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			abs, err := filepath.Abs(p)
			if err == nil {
				return abs
			}
			return p
		}
	}
	return filepath.Join(cwd, "portable")
}

func lanURLs(port int) []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			out = append(out, "http://"+ipnet.IP.String()+":"+itoa(port)+"/")
		}
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [16]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
