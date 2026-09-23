import { createSocket, type Socket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { buildRtspUrls, guessPresetId, collectLanScanPorts, guessPresetFromOpenPorts } from '../../shared/camera-presets'

export type ScanMode = 'auto' | 'onvif' | 'lan'

export type DiscoveredCamera = {
  id: string
  host: string
  port: number
  /** open ports observed during LAN scan */
  openPorts: number[]
  source: 'onvif' | 'lan'
  manufacturer?: string
  model?: string
  name?: string
  xaddrs?: string[]
  scopes?: string[]
  presetId: string
  suggestedUrl: string
  suggestedPreviewUrl: string
}

export type DeviceScanOptions = {
  mode: ScanMode
  /** e.g. 192.168.1.0/24 — only for lan mode; empty → auto local /24s */
  cidr?: string
  username?: string
  password?: string
  /** LAN: ports to probe. Default: union of vendor preset scanPorts. */
  ports?: number[]
  /** Preferred preset when only RTSP 554 is open (e.g. ezviz). */
  preferredPresetId?: string
  /** When true (auto fill-in), only scan the primary LAN /24. */
  primarySubnetOnly?: boolean
  timeoutMs?: number
  concurrency?: number
  onProgress?: (done: number, total: number, message: string) => void
  signal?: AbortSignal
}

export type DeviceScanResult = {
  ok: true
  cameras: DiscoveredCamera[]
  durationMs: number
  scannedHosts: number
}

function aborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted
}

function isLikelyVirtualIface(name: string): boolean {
  const n = name.toLowerCase()
  return /vethernet|hyper-?v|docker|wsl|vmware|virtualbox|vbox|tailscale|zerotier|hamachi|npcap|loopback|isatap|teredo|bluetooth|radmin|softether|vpn|tap-?win|wintun|wireguard|openvpn|clash|sing-?box|outline|nord|anyconnect|forti|globalprotect|sstap|babylink|baby.?link|tun|ppp|wan miniport|虚拟|meta/.test(
    n,
  )
}

type LocalSubnet = { base: string; address: string; iface: string; virtual?: boolean }

export type ScanSubnetInfo = {
  cidr: string
  address: string
  iface: string
  /** Prefer for auto scan (real LAN). */
  recommended: boolean
  /** VPN / virtual adapter — selectable but not default. */
  virtual: boolean
}

/** Prefer real LAN (192.168 / 以太网) over VPN tunnels like 10.222.x. */
function subnetPreference(s: LocalSubnet): number {
  const parts = s.address.split('.').map(Number)
  const iface = s.iface.toLowerCase()
  let score = 0
  if (s.virtual) score -= 150
  if (parts[0] === 192 && parts[1] === 168) score += 200
  else if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) score += 40
  else if (parts[0] === 10) {
    score += 20
    // Odd corporate/VPN-style 10.x (e.g. 10.222.222) — deprioritize
    if (parts[1]! >= 100) score -= 80
  }
  if (/以太网|ethernet|wi-?fi|wlan|无线|本地连接/.test(iface)) score += 80
  if (/vpn|tap|tun|ppp|baby|link|vmware|vethernet|docker|wsl/.test(iface)) score -= 200
  return score
}

function collectAllLocalSubnets(): LocalSubnet[] {
  const out: LocalSubnet[] = []
  const seen = new Set<string>()
  const ifs = networkInterfaces()
  for (const [iface, list] of Object.entries(ifs)) {
    if (!list) continue
    const virtual = isLikelyVirtualIface(iface)
    for (const a of list) {
      if (a.internal) continue
      const family = String(a.family)
      if (family !== 'IPv4' && family !== '4') continue
      const parts = a.address.split('.').map(Number)
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) continue
      if (parts[0] === 169 && parts[1] === 254) continue
      const base = `${parts[0]}.${parts[1]}.${parts[2]}`
      if (seen.has(base)) continue
      seen.add(base)
      out.push({ base, address: a.address, iface, virtual })
    }
  }
  out.sort((a, b) => subnetPreference(b) - subnetPreference(a))
  return out
}

function listLocalSubnets(): LocalSubnet[] {
  return collectAllLocalSubnets().filter((s) => !s.virtual)
}

/** Subnets for UI picker (includes VPN, recommended first). */
export function listScanSubnets(): ScanSubnetInfo[] {
  return collectAllLocalSubnets().map((s) => ({
    cidr: `${s.base}.0/24`,
    address: s.address,
    iface: s.iface,
    recommended: !s.virtual && subnetPreference(s) >= 100,
    virtual: !!s.virtual,
  }))
}

function localIpv4Bases(primaryOnly = false): string[] {
  const list = listLocalSubnets()
  if (!list.length) return []
  if (primaryOnly) return [list[0]!.base]
  return list.map((x) => x.base)
}

function hostsFromCidr(cidr: string): string[] {
  const raw = cidr.trim()
  const m = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/)
  if (!m) return []
  const a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (a.some((n) => n > 255)) return []
  const prefix = m[5] != null ? Number(m[5]) : 24
  if (prefix < 16 || prefix > 30) return []
  const ip =
    ((a[0]! << 24) >>> 0) + ((a[1]! << 16) >>> 0) + ((a[2]! << 8) >>> 0) + (a[3]! >>> 0)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const net = (ip & mask) >>> 0
  const size = 2 ** (32 - prefix)
  const hosts: string[] = []
  for (let i = 1; i < size - 1; i++) {
    const v = (net + i) >>> 0
    hosts.push(`${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`)
  }
  return hosts
}

/** Local /24 targets. `primaryOnly` avoids scanning every virtual NIC subnet. */
function expandLanTargets(cidr?: string, primaryOnly = false): string[] {
  if (cidr?.trim()) return hostsFromCidr(cidr)
  const bases = localIpv4Bases(primaryOnly)
  const self = new Set(listLocalSubnets().map((s) => s.address))
  const hosts: string[] = []
  for (const base of bases) {
    for (let i = 1; i <= 254; i++) {
      const host = `${base}.${i}`
      if (self.has(host)) continue
      hosts.push(host)
    }
  }
  return [...new Set(hosts)]
}

function probeTcpPort(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (aborted(signal)) {
      resolve(false)
      return
    }
    const socket = netConnect({ host, port })
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      finish(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(false)
    })
  })
}

/**
 * Confirm the service speaks RTSP (VPN tunnels often accept TCP to every IP:port).
 * Sends OPTIONS and expects an RTSP/ status line.
 */
function probeRtspSpeak(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (aborted(signal)) {
      resolve(false)
      return
    }
    const socket = netConnect({ host, port })
    let done = false
    let buf = ''
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      finish(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('connect', () => {
      try {
        socket.write('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: NavoraMonitor\r\n\r\n')
      } catch {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        finish(false)
      }
    })
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (/^RTSP\/1\.\d/i.test(buf) || buf.includes('RTSP/1.')) {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        finish(true)
      } else if (buf.length > 64) {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        finish(false)
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish(false)
    })
  })
}

/** Max LAN hits before treating the subnet as a sinkhole (e.g. VPN accepting all). */
const LAN_HIT_SANITY_CAP = 24

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      if (aborted(signal)) return
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return results
}

function parseOnvifScopes(xml: string): string[] {
  const m = xml.match(/<[^>]*Scopes[^>]*>([\s\S]*?)<\/[^>]*Scopes>/i)
  if (!m?.[1]) return []
  return m[1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseXAddrs(xml: string): string[] {
  const m = xml.match(/<[^>]*XAddrs[^>]*>([\s\S]*?)<\/[^>]*XAddrs>/i)
  if (!m?.[1]) return []
  return m[1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function hostFromUrl(u: string): string | null {
  try {
    const url = new URL(u)
    return url.hostname || null
  } catch {
    const m = u.match(/:\/\/([^/:]+)/)
    return m?.[1] ?? null
  }
}

function scopeName(scopes: string[]): string | undefined {
  for (const s of scopes) {
    const m = s.match(/onvif:\/\/www\.onvif\.org\/name\/([^/\s]+)/i)
    if (m?.[1]) return decodeURIComponent(m[1].replace(/\+/g, ' '))
  }
  return undefined
}

function scopeHardware(scopes: string[]): string | undefined {
  for (const s of scopes) {
    const m = s.match(/onvif:\/\/www\.onvif\.org\/hardware\/([^/\s]+)/i)
    if (m?.[1]) return decodeURIComponent(m[1].replace(/\+/g, ' '))
  }
  return undefined
}

function buildSuggested(
  host: string,
  presetId: string,
  username?: string,
  password?: string,
  port = 554,
): Pick<DiscoveredCamera, 'suggestedUrl' | 'suggestedPreviewUrl' | 'presetId' | 'port'> {
  const built = buildRtspUrls({
    presetId,
    host,
    port,
    username,
    password,
    channel: 1,
  })
  if (built) {
    return {
      presetId: built.presetId,
      port: built.port,
      suggestedUrl: built.url,
      suggestedPreviewUrl: built.previewUrl,
    }
  }
  const auth =
    username?.trim()
      ? `${encodeURIComponent(username.trim())}:${encodeURIComponent(password ?? '')}@`
      : ''
  return {
    presetId: 'custom',
    port,
    suggestedUrl: `rtsp://${auth}${host}:${port}/`,
    suggestedPreviewUrl: `rtsp://${auth}${host}:${port}/`,
  }
}

async function scanOnvif(opts: DeviceScanOptions): Promise<DiscoveredCamera[]> {
  const timeoutMs = opts.timeoutMs ?? 4000
  const probe = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>uuid:${randomUUID()}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe>
      <d:Types>dn:NetworkVideoTransmitter</d:Types>
    </d:Probe>
  </e:Body>
</e:Envelope>`

  const byHost = new Map<string, DiscoveredCamera>()

  await new Promise<void>((resolve) => {
    let socket: Socket
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true })
    } catch (e) {
      opts.onProgress?.(0, 1, e instanceof Error ? e.message : '无法创建 UDP socket')
      resolve()
      return
    }

    const finish = () => {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve()
    }

    const timer = setTimeout(finish, timeoutMs)
    const onAbort = () => {
      clearTimeout(timer)
      finish()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    socket.on('message', (msg) => {
      const xml = msg.toString('utf8')
      if (!/ProbeMatches|XAddrs/i.test(xml)) return
      const xaddrs = parseXAddrs(xml)
      const scopes = parseOnvifScopes(xml)
      const host = xaddrs.map(hostFromUrl).find((h): h is string => !!h)
      if (!host || byHost.has(host)) return
      const manufacturer = scopeName(scopes)
      const model = scopeHardware(scopes)
      const presetId = guessPresetId([manufacturer, model, ...scopes].filter(Boolean).join(' '))
      const suggested = buildSuggested(host, presetId, opts.username, opts.password, 554)
      byHost.set(host, {
        id: `onvif-${host}`,
        host,
        openPorts: [554],
        source: 'onvif',
        manufacturer,
        model,
        name: manufacturer ? `${manufacturer}${model ? ` ${model}` : ''}` : host,
        xaddrs,
        scopes,
        ...suggested,
      })
      opts.onProgress?.(byHost.size, byHost.size, `ONVIF 发现 ${host}`)
    })

    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(4)
        socket.send(Buffer.from(probe, 'utf8'), 3702, '239.255.255.250')
        // also try a second probe without Types filter for stubborn devices
        setTimeout(() => {
          if (aborted(opts.signal)) return
          try {
            socket.send(
              Buffer.from(probe.replace(/<d:Types>[\s\S]*?<\/d:Types>/, ''), 'utf8'),
              3702,
              '239.255.255.250',
            )
          } catch {
            /* ignore */
          }
        }, 200)
      } catch {
        clearTimeout(timer)
        finish()
      }
    })
  })

  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
}

async function scanLan(opts: DeviceScanOptions): Promise<{ cameras: DiscoveredCamera[]; scannedHosts: number }> {
  const hosts = expandLanTargets(opts.cidr, !!opts.primarySubnetOnly)
  const ports = opts.ports?.length ? opts.ports : collectLanScanPorts()
  const concurrency = opts.concurrency ?? 48
  const perPortTimeout = Math.min(700, opts.timeoutMs ?? 500)
  const rtspTimeout = Math.min(1200, (opts.timeoutMs ?? 500) + 400)
  let done = 0
  const total = hosts.length
  const primary = listLocalSubnets()[0]
  const subnetHint = opts.cidr?.trim()
    ? opts.cidr.trim()
    : opts.primarySubnetOnly
      ? `${primary?.base ?? '?'}.0/24${primary ? ` · ${primary.iface}` : ''}`
      : '本机网段'
  opts.onProgress?.(0, total, `扫描 ${subnetHint}（厂商口 ${ports.join('/')} + RTSP 校验）…`)

  const found: DiscoveredCamera[] = []
  let abortedForCap = false

  await mapPool(
    hosts,
    concurrency,
    async (host) => {
      if (aborted(opts.signal) || abortedForCap) return
      // Cheap TCP check first; VPN sinkholes often accept every connect
      const tcp554 = await probeTcpPort(host, 554, perPortTimeout, opts.signal)
      done += 1
      if (done % 16 === 0 || done === total) {
        opts.onProgress?.(done, total, `已扫描 ${done}/${total} · 命中 ${found.length}`)
      }
      if (!tcp554) return
      if (!(await probeRtspSpeak(host, 554, rtspTimeout, opts.signal))) return

      const open: number[] = [554]
      for (const port of ports) {
        if (port === 554) continue
        if (await probeTcpPort(host, port, perPortTimeout, opts.signal)) open.push(port)
      }

      let presetId = guessPresetFromOpenPorts(open) ?? 'hikvision'
      if (open.length === 1 && open[0] === 554 && opts.preferredPresetId) {
        presetId = opts.preferredPresetId
      }
      const suggested = buildSuggested(host, presetId, opts.username, opts.password, 554)
      found.push({
        id: `lan-${host}`,
        host,
        openPorts: open,
        source: 'lan',
        name: host,
        ...suggested,
      })
      if (found.length >= LAN_HIT_SANITY_CAP) {
        abortedForCap = true
        opts.onProgress?.(
          done,
          total,
          `命中已达 ${LAN_HIT_SANITY_CAP}，疑似 VPN/黑洞网段，已停止（请改扫 192.168.x）`,
        )
      }
    },
    opts.signal,
  )

  if (abortedForCap) {
    return { cameras: [], scannedHosts: hosts.length }
  }

  found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }))
  return { cameras: found, scannedHosts: hosts.length }
}

async function scanDevices(opts: DeviceScanOptions): Promise<DeviceScanResult> {
  const started = Date.now()
  if (opts.mode === 'onvif') {
    opts.onProgress?.(0, 1, 'ONVIF 组播发现中…')
    const cameras = await scanOnvif(opts)
    return {
      ok: true,
      cameras,
      durationMs: Date.now() - started,
      scannedHosts: cameras.length,
    }
  }
  if (opts.mode === 'lan') {
    const { cameras, scannedHosts } = await scanLan({
      ...opts,
      primarySubnetOnly: opts.primarySubnetOnly ?? !opts.cidr?.trim(),
    })
    return {
      ok: true,
      cameras,
      durationMs: Date.now() - started,
      scannedHosts,
    }
  }

  // auto: ONVIF first; if empty, LAN by vendor scanPorts
  opts.onProgress?.(0, 2, '一键扫描：ONVIF 发现中…')
  const onvifCams = await scanOnvif(opts)
  if (aborted(opts.signal)) {
    return {
      ok: true,
      cameras: onvifCams,
      durationMs: Date.now() - started,
      scannedHosts: onvifCams.length,
    }
  }
  if (onvifCams.length > 0) {
    opts.onProgress?.(2, 2, `ONVIF 已发现 ${onvifCams.length} 台，跳过网段扫`)
    return {
      ok: true,
      cameras: onvifCams,
      durationMs: Date.now() - started,
      scannedHosts: onvifCams.length,
    }
  }

  const vendorPorts = collectLanScanPorts()
  opts.onProgress?.(1, 2, `ONVIF 无结果，按厂商口扫描（${vendorPorts.join('/')}）…`)
  const lan = await scanLan({
    ...opts,
    ports: vendorPorts,
    primarySubnetOnly: true,
  })
  return {
    ok: true,
    cameras: lan.cameras,
    durationMs: Date.now() - started,
    scannedHosts: lan.scannedHosts,
  }
}

let scanAbort: AbortController | null = null

export function cancelDeviceScan(): void {
  scanAbort?.abort()
  scanAbort = null
}

export async function runDeviceScan(
  opts: Omit<DeviceScanOptions, 'signal'>,
): Promise<DeviceScanResult | { ok: false; canceled: true } | { ok: false; error: string }> {
  cancelDeviceScan()
  const ac = new AbortController()
  scanAbort = ac
  try {
    const result = await scanDevices({ ...opts, signal: ac.signal })
    if (ac.signal.aborted) return { ok: false, canceled: true }
    return result
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, canceled: true }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (scanAbort === ac) scanAbort = null
  }
}
