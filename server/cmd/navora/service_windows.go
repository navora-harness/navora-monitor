//go:build windows

package main

import (
	"log"
	"os"
	"time"

	"github.com/navora-harness/navora-monitor/server/internal/core"
	"golang.org/x/sys/windows/svc"
)

func maybeRunWindowsService() bool {
	isSvc, err := svc.IsWindowsService()
	if err != nil || !isSvc {
		return false
	}
	data, addr, port := parseServiceArgs(os.Args[1:])
	err = svc.Run(core.SystemServiceName, &windowsService{
		data: data,
		addr: addr,
		port: port,
	})
	if err != nil {
		log.Printf("service stopped: %v", err)
	}
	return true
}

func parseServiceArgs(args []string) (data, addr string, port int) {
	addr = "0.0.0.0"
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--data" && i+1 < len(args):
			i++
			data = args[i]
		case len(a) > 7 && a[:7] == "--data=":
			data = a[7:]
		case a == "--addr" && i+1 < len(args):
			i++
			addr = args[i]
		case len(a) > 7 && a[:7] == "--addr=":
			addr = a[7:]
		case a == "--port" && i+1 < len(args):
			i++
			port = atoiSimple(args[i])
		case len(a) > 7 && a[:7] == "--port=":
			port = atoiSimple(a[7:])
		}
	}
	return data, addr, port
}

func atoiSimple(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

type windowsService struct {
	data string
	addr string
	port int
}

func (ws *windowsService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	root := resolveData(ws.data)
	app, err := core.Open(root)
	if err != nil {
		log.Printf("service open data: %v", err)
		return true, 1
	}
	if _, _, _, err := app.EnsurePassword(false); err != nil {
		log.Printf("service password: %v", err)
		return true, 1
	}
	settings := app.Settings()
	listenPort := settings.RemotePort
	if ws.port != 0 {
		listenPort = ws.port
	}
	host := ws.addr
	if host == "" {
		host = "0.0.0.0"
	}
	app.SetListen(listenPort, lanURLs(listenPort))
	go app.RunLoops()

	done := make(chan error, 1)
	go func() {
		done <- serveHTTP(app, host, listenPort)
	}()

	changes <- svc.Status{State: svc.Running, Accepts: accepts}
	for {
		select {
		case err := <-done:
			if err != nil {
				log.Printf("service http: %v", err)
				return true, 1
			}
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				app.RequestShutdown()
				deadline := time.NewTimer(30 * time.Second)
				for {
					select {
					case <-done:
						deadline.Stop()
						return false, 0
					case <-deadline.C:
						return false, 0
					case c2 := <-r:
						if c2.Cmd == svc.Interrogate {
							changes <- c2.CurrentStatus
						}
					}
				}
			}
		}
	}
}
