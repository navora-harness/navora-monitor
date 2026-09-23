/** Vendor RTSP URL presets — mirrors common NVR / CMS add-camera shortcuts. */

export type CameraStreamKind = 'main' | 'sub'

export type CameraVendorPreset = {
  id: string
  label: string
  brand: string
  defaultPort: number
  /**
   * LAN discovery ports for this brand.
   * Include RTSP and vendor-specific SDK/HTTP (e.g. Hik 8000, Dahua 37777).
   * Generic 80/443 alone must not be listed — they flood false positives.
   */
  scanPorts?: number[]
  /** Build path for stream; channel is 1-based. */
  path: (channel: number, stream: CameraStreamKind) => string
  hint?: string
}

export type RtspBuildInput = {
  presetId: string
  host: string
  port?: number
  username?: string
  password?: string
  /** 1-based channel index (NVR / multi-sensor). */
  channel?: number
}

export type BuiltRtspUrls = {
  presetId: string
  url: string
  previewUrl: string
  host: string
  port: number
}

function hikChannelToken(channel: number, stream: CameraStreamKind): string {
  const ch = Math.max(1, Math.min(64, Math.round(channel) || 1))
  const suffix = stream === 'main' ? '01' : '02'
  return `${ch}${suffix}`
}

export const CAMERA_PRESETS: CameraVendorPreset[] = [
  {
    id: 'hikvision',
    label: '海康 Hikvision',
    brand: 'Hikvision',
    defaultPort: 554,
    scanPorts: [554, 8000],
    path: (ch, stream) => `/Streaming/Channels/${hikChannelToken(ch, stream)}`,
    hint: '主码流 ch101 / 子码流 ch102；NVR 第 2 路为 201/202；发现口 554/8000',
  },
  {
    id: 'ezviz',
    label: '萤石 EZVIZ',
    brand: '萤石',
    defaultPort: 554,
    scanPorts: [554],
    path: (ch, stream) =>
      `/h264/ch${Math.max(1, Math.round(ch) || 1)}/${stream === 'main' ? 'main' : 'sub'}/av_stream`,
    hint: '密码为机身验证码；双摄：通道1=镜头1，通道2=镜头2（如 H9c 广角/云台）',
  },
  {
    id: 'dahua',
    label: '大华 Dahua / 华视 Amcrest',
    brand: 'Dahua',
    defaultPort: 554,
    scanPorts: [554, 37777],
    path: (ch, stream) =>
      `/cam/realmonitor?channel=${Math.max(1, ch)}&subtype=${stream === 'main' ? 0 : 1}`,
    hint: 'subtype=0 主码流，1 子码流；发现口 554/37777',
  },
  {
    id: 'uniview',
    label: '宇视 Uniview',
    brand: 'Uniview',
    defaultPort: 554,
    scanPorts: [554],
    path: (ch, stream) => `/media/video${Math.max(1, ch)}${stream === 'main' ? '' : '2'}`,
    hint: '常见 /media/video1（主）/media/video2（子）',
  },
  {
    id: 'reolink',
    label: 'Reolink',
    brand: 'Reolink',
    defaultPort: 554,
    scanPorts: [554],
    path: (ch, stream) => {
      const n = String(Math.max(1, ch)).padStart(2, '0')
      return `/h264Preview_${n}_${stream === 'main' ? 'main' : 'sub'}`
    },
  },
  {
    id: 'tplink',
    label: 'TP-Link VIGI',
    brand: 'TP-Link',
    defaultPort: 554,
    scanPorts: [554],
    path: (_ch, stream) => (stream === 'main' ? '/stream1' : '/stream2'),
  },
  {
    id: 'axis',
    label: 'Axis',
    brand: 'Axis',
    defaultPort: 554,
    scanPorts: [554],
    path: (_ch, stream) =>
      stream === 'main' ? '/axis-media/media.amp' : '/axis-media/media.amp?videocodec=h264&resolution=640x360',
  },
  {
    id: 'onvif',
    label: '通用 ONVIF',
    brand: 'ONVIF',
    defaultPort: 554,
    scanPorts: [554],
    path: (_ch, stream) => (stream === 'main' ? '/onvif1' : '/onvif2'),
    hint: '部分设备路径因固件而异，发现后请以实机为准',
  },
  {
    id: 'custom',
    label: '自定义 / 手动',
    brand: 'Custom',
    defaultPort: 554,
    path: () => '/',
  },
]

/** Distinctive non-RTSP ports that identify a brand without relying on open 80/443. */
const VENDOR_FINGERPRINT_PORTS: Record<number, string> = {
  8000: 'hikvision',
  37777: 'dahua',
}

export function getCameraPreset(id: string): CameraVendorPreset | undefined {
  return CAMERA_PRESETS.find((p) => p.id === id)
}

/** Union of vendor discovery ports (sorted), used by LAN scan. */
export function collectLanScanPorts(): number[] {
  const set = new Set<number>()
  for (const p of CAMERA_PRESETS) {
    if (p.id === 'custom' || !p.scanPorts?.length) continue
    for (const port of p.scanPorts) {
      if (port > 0 && port <= 65535) set.add(port)
    }
  }
  if (!set.size) set.add(554)
  return [...set].sort((a, b) => a - b)
}

/**
 * Guess vendor from open TCP ports.
 * Prefer fingerprint ports (8000/37777); else RTSP 554 → hikvision
 * (path can be switched to 萤石 etc. in the UI). Returns null if no camera-like hit.
 */
export function guessPresetFromOpenPorts(openPorts: number[]): string | null {
  const open = new Set(openPorts)
  for (const [port, presetId] of Object.entries(VENDOR_FINGERPRINT_PORTS)) {
    if (open.has(Number(port))) return presetId
  }
  if (open.has(554)) return 'hikvision'
  return null
}

export function encodeRtspUserInfo(username?: string, password?: string): string {
  const u = (username ?? '').trim()
  if (!u) return ''
  const p = password ?? ''
  return `${encodeURIComponent(u)}:${encodeURIComponent(p)}@`
}

export function buildRtspUrls(input: RtspBuildInput): BuiltRtspUrls | null {
  const host = input.host.trim().replace(/^\[|\]$/g, '')
  if (!host) return null
  const preset = getCameraPreset(input.presetId) ?? getCameraPreset('hikvision')!
  if (preset.id === 'custom') return null
  const channel = Math.max(1, Math.round(input.channel ?? 1) || 1)
  const port = Math.max(1, Math.min(65535, Math.round(input.port ?? preset.defaultPort) || preset.defaultPort))
  const auth = encodeRtspUserInfo(input.username, input.password)
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const base = `rtsp://${auth}${hostPart}:${port}`
  return {
    presetId: preset.id,
    url: `${base}${preset.path(channel, 'main')}`,
    previewUrl: `${base}${preset.path(channel, 'sub')}`,
    host,
    port,
  }
}

/** Guess vendor preset from ONVIF scopes / manufacturer string. */
export function guessPresetId(manufacturerOrScopes: string): string {
  const s = manufacturerOrScopes.toLowerCase()
  if (/ezviz|萤石|ezvizlife/.test(s)) return 'ezviz'
  if (/hikvision|杭州海康|hik\b/.test(s)) return 'hikvision'
  if (/dahua|大华|amcrest|lorex/.test(s)) return 'dahua'
  if (/uniview|宇视|uniarch/.test(s)) return 'uniview'
  if (/reolink/.test(s)) return 'reolink'
  if (/tp-?link|vigi|tenda/.test(s)) return 'tplink'
  if (/axis/.test(s)) return 'axis'
  if (/onvif/.test(s)) return 'onvif'
  return 'hikvision'
}
