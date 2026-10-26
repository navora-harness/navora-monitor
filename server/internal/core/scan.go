package core

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type Camera struct {
	ID                  string `json:"id"`
	Host                string `json:"host"`
	Port                int    `json:"port"`
	OpenPorts           []int  `json:"openPorts"`
	Source              string `json:"source"`
	Name                string `json:"name,omitempty"`
	PresetID            string `json:"presetId"`
	SuggestedURL        string `json:"suggestedUrl"`
	SuggestedPreviewURL string `json:"suggestedPreviewUrl"`
}

type Subnet struct {
	CIDR        string `json:"cidr"`
	Address     string `json:"address"`
	Iface       string `json:"iface"`
	Recommended bool   `json:"recommended"`
	Virtual     bool   `json:"virtual"`
}

type ScanProgress struct {
	Done    int    `json:"done"`
	Total   int    `json:"total"`
	Message string `json:"message"`
}

func (c *Core) Subnets() []Subnet {
	var out []Subnet
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		virtual := virtualIface(iface.Name)
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil {
				continue
			}
			ip := ipnet.IP.To4()
			base := fmt.Sprintf("%d.%d.%d.0", ip[0], ip[1], ip[2])
			out = append(out, Subnet{
				CIDR:        base + "/24",
				Address:     ip.String(),
				Iface:       iface.Name,
				Virtual:     virtual,
				Recommended: !virtual && ip[0] == 192 && ip[1] == 168,
			})
		}
	}
	return out
}

func virtualIface(name string) bool {
	n := strings.ToLower(name)
	keys := []string{"vethernet", "hyper-v", "docker", "wsl", "vmware", "virtualbox", "vbox", "tailscale", "zerotier", "wintun", "wireguard", "tap", "tun", "vpn", "bluetooth", "loopback"}
	for _, k := range keys {
		if strings.Contains(n, k) {
			return true
		}
	}
	return false
}

func (c *Core) CancelScan() {
	c.scanMu.Lock()
	defer c.scanMu.Unlock()
	if c.scanCancel != nil {
		c.scanCancel()
	}
}

func (c *Core) Scan(mode, cidr, user, pass, preset string) ([]Camera, int, error) {
	return c.ScanContext(context.Background(), mode, cidr, user, pass, preset)
}

func (c *Core) ScanContext(parent context.Context, mode, cidr, user, pass, preset string) ([]Camera, int, error) {
	if mode != "auto" && mode != "lan" && mode != "onvif" {
		return nil, 0, fmt.Errorf("无效扫描方式")
	}
	var subnets []string
	if strings.TrimSpace(cidr) != "" {
		subnets = []string{strings.TrimSpace(cidr)}
	} else {
		for _, s := range c.Subnets() {
			if mode == "auto" && s.Virtual {
				continue
			}
			subnets = append(subnets, s.CIDR)
		}
	}
	var all []string
	seen := map[string]bool{}
	if mode != "onvif" {
		for _, subnet := range subnets {
			hosts, err := scanHosts(subnet)
			if err != nil {
				return nil, 0, err
			}
			for _, host := range hosts {
				if !seen[host] {
					seen[host] = true
					all = append(all, host)
				}
			}
		}
		if len(all) > 4096 {
			return nil, 0, fmt.Errorf("扫描范围过大，请指定一个 /23 或更小的 IPv4 网段")
		}
	}
	ctx, cancel := context.WithCancel(parent)
	c.scanMu.Lock()
	if c.scanCancel != nil {
		c.scanCancel()
	}
	c.scanID++
	id := c.scanID
	c.scanCancel = cancel
	c.scanMu.Unlock()
	defer func() {
		cancel()
		c.scanMu.Lock()
		if c.scanID == id {
			c.scanCancel = nil
		}
		c.scanMu.Unlock()
	}()
	select {
	case <-c.shutdownCh:
		cancel()
	default:
	}
	if ctx.Err() != nil {
		return nil, 0, ctx.Err()
	}
	found := map[string]*Camera{}
	if mode != "lan" {
		c.discoverONVIF(ctx, found, user, pass, preset)
	}
	if mode != "onvif" && ctx.Err() == nil {
		c.scanLAN(ctx, all, found, user, pass, preset)
	}
	if ctx.Err() != nil {
		return nil, len(all), ctx.Err()
	}
	var list []Camera
	for _, cam := range found {
		list = append(list, *cam)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Host < list[j].Host })
	return list, len(all), nil
}

func (c *Core) publishScan(done, total int, msg string) {
	c.events.Publish("scan", ScanProgress{Done: done, Total: total, Message: msg})
}

func (c *Core) discoverONVIF(ctx context.Context, found map[string]*Camera, user, pass, preset string) {
	c.publishScan(0, 1, "正在进行 ONVIF 发现")
	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		return
	}
	defer conn.Close()
	stopCancel := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopCancel()
	msg := `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:navora-scan</w:MessageID><w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`
	dst, err := net.ResolveUDPAddr("udp4", "239.255.255.250:3702")
	if err != nil {
		return
	}
	_, _ = conn.WriteTo([]byte(msg), dst)
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 8192)
	for {
		if ctx.Err() != nil {
			return
		}
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			return
		}
		host := ""
		if u, ok := addr.(*net.UDPAddr); ok {
			host = u.IP.String()
		}
		body := string(buf[:n])
		if i := strings.Index(body, "http://"); i >= 0 {
			rest := body[i:]
			if j := strings.IndexAny(rest, " <\""); j > 0 {
				if h := hostFromURL(rest[:j]); h != "" {
					host = h
				}
			}
		}
		if host == "" {
			continue
		}
		if _, ok := found[host]; ok {
			continue
		}
		id := preset
		if id == "" {
			id = "hikvision"
		}
		main, sub := rtspPair(id, host, 554, user, pass, 1)
		found[host] = &Camera{
			ID: host, Host: host, Port: 554, OpenPorts: []int{3702}, Source: "onvif",
			Name: host, PresetID: id, SuggestedURL: main, SuggestedPreviewURL: sub,
		}
	}
}

func hostFromURL(raw string) string {
	raw = strings.TrimPrefix(raw, "http://")
	raw = strings.TrimPrefix(raw, "https://")
	if i := strings.IndexAny(raw, "/:"); i >= 0 {
		raw = raw[:i]
	}
	if net.ParseIP(raw) == nil {
		return ""
	}
	return raw
}

func hostsInCIDR(cidr string) []string {
	hosts, _ := scanHosts(cidr)
	return hosts
}

func scanHosts(cidr string) ([]string, error) {
	if ip := net.ParseIP(cidr); ip != nil && ip.To4() != nil {
		v := ip.To4()
		cidr = fmt.Sprintf("%d.%d.%d.0/24", v[0], v[1], v[2])
	}
	ip, network, err := net.ParseCIDR(cidr)
	if err != nil || ip.To4() == nil {
		return nil, fmt.Errorf("请输入有效的 IPv4 网段，例如 192.168.1.0/24")
	}
	prefix, bits := network.Mask.Size()
	if bits != 32 || prefix < 23 {
		return nil, fmt.Errorf("每次扫描支持 /23 或更小的 IPv4 网段，请缩小范围；不会截断扫描结果")
	}
	base := ip.To4().Mask(network.Mask)
	count := 1 << uint(32-prefix)
	hosts := make([]string, 0, count)
	for n := 0; n < count; n++ {
		if prefix >= 31 || (n != 0 && n != count-1) {
			hosts = append(hosts, base.String())
		}
		incIP(base)
	}
	return hosts, nil
}

func incIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}

func (c *Core) scanLAN(ctx context.Context, hosts []string, found map[string]*Camera, user, pass, preset string) {
	total := len(hosts)
	if total == 0 {
		c.publishScan(0, 0, "没有可扫描的网段")
		return
	}
	ports := []int{554, 8000, 37777}
	var mu sync.Mutex
	sem := make(chan struct{}, 64)
	var wg sync.WaitGroup
	done := 0
	for _, host := range hosts {
		if ctx.Err() != nil {
			break
		}
		host := host
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			var open []int
			for _, port := range ports {
				if ctx.Err() != nil {
					return
				}
				d := net.Dialer{Timeout: 280 * time.Millisecond}
				conn, err := d.DialContext(ctx, "tcp", fmt.Sprintf("%s:%d", host, port))
				if err == nil {
					_ = conn.Close()
					open = append(open, port)
				}
			}
			mu.Lock()
			done++
			if done%16 == 0 || done == total {
				c.publishScan(done, total, fmt.Sprintf("已扫描 %d/%d", done, total))
			}
			if len(open) > 0 {
				if _, ok := found[host]; !ok {
					id := guessPreset(open, preset)
					main, sub := rtspPair(id, host, 554, user, pass, 1)
					found[host] = &Camera{
						ID: host, Host: host, Port: 554, OpenPorts: open, Source: "lan",
						Name: host, PresetID: id, SuggestedURL: main, SuggestedPreviewURL: sub,
					}
				}
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	if ctx.Err() == nil {
		c.publishScan(total, total, "扫描完成")
	}
}

func guessPreset(ports []int, preferred string) string {
	has := func(p int) bool {
		for _, x := range ports {
			if x == p {
				return true
			}
		}
		return false
	}
	if has(37777) {
		return "dahua"
	}
	if has(8000) {
		return "hikvision"
	}
	if preferred != "" {
		return preferred
	}
	return "hikvision"
}

func rtspPair(preset, host string, port int, user, pass string, ch int) (string, string) {
	if ch < 1 {
		ch = 1
	}
	auth := ""
	if user != "" {
		auth = url.User(user).String()
		if pass != "" {
			auth = url.UserPassword(user, pass).String()
		}
		auth += "@"
	}
	var mainPath, subPath string
	switch preset {
	case "ezviz":
		mainPath = fmt.Sprintf("/h264/ch%d/main/av_stream", ch)
		subPath = fmt.Sprintf("/h264/ch%d/sub/av_stream", ch)
	case "dahua":
		mainPath = fmt.Sprintf("/cam/realmonitor?channel=%d&subtype=0", ch)
		subPath = fmt.Sprintf("/cam/realmonitor?channel=%d&subtype=1", ch)
	default:
		mainPath = fmt.Sprintf("/Streaming/Channels/%d01", ch)
		subPath = fmt.Sprintf("/Streaming/Channels/%d02", ch)
		preset = "hikvision"
	}
	base := fmt.Sprintf("rtsp://%s%s:%d", auth, host, port)
	return base + mainPath, base + subPath
}
