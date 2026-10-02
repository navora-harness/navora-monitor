/** Probe whether this browser can play HEVC in MSE (mpegts.js / fMP4). */

const HEVC_MSE_TYPES = [
  'video/mp4;codecs="hvc1.1.1.L150.B0"',
  'video/mp4;codecs="hvc1.1.1.L120.B0"',
  'video/mp4;codecs="hvc1"',
  'video/mp4;codecs="hev1.1.1.L150.B0"',
  'video/mp4;codecs="hev1"',
]

export function browserSupportsHevcMse(): boolean {
  if (typeof window === 'undefined') return false
  const MSE = window.MediaSource
  if (!MSE || typeof MSE.isTypeSupported !== 'function') return false
  return HEVC_MSE_TYPES.some((t) => {
    try {
      return MSE.isTypeSupported(t)
    } catch {
      return false
    }
  })
}

export function isHevcMseError(...args: unknown[]): boolean {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a && typeof a === 'object') {
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      }
      return String(a ?? '')
    })
    .join(' ')
    .toLowerCase()
  if (!text) return false
  const codec = text.includes('hvc1') || text.includes('hev1') || text.includes('hevc')
  const fail =
    text.includes('addsourcebuffer') ||
    text.includes('unsupported') ||
    text.includes('not supported') ||
    text.includes('mediaseerror') ||
    text.includes('mediaerror')
  return codec && fail
}
