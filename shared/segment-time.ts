/** Parse wall-clock start time encoded in recording segment filenames. */

/** Matches `...-YYYYMMDD-HHMMSS.mp4` (strftime segment names). */
const STAMP_RE = /(\d{8})-(\d{6})(?:\.[^.]+)?$/i

/**
 * Parse start time from a segment file name.
 * @returns epoch ms or null
 */
export function parseSegmentStartMs(fileName: string): number | null {
  const m = STAMP_RE.exec(fileName)
  if (!m) return null
  const d = m[1]!
  const t = m[2]!
  const y = Number(d.slice(0, 4))
  const mo = Number(d.slice(4, 6)) - 1
  const day = Number(d.slice(6, 8))
  const h = Number(t.slice(0, 2))
  const mi = Number(t.slice(2, 4))
  const s = Number(t.slice(4, 6))
  if (![y, mo, day, h, mi, s].every((n) => Number.isFinite(n))) return null
  const dt = new Date(y, mo, day, h, mi, s)
  const ms = dt.getTime()
  return Number.isFinite(ms) ? ms : null
}

/** FFmpeg strftime pattern appended after channel stem: `Stem-%Y%m%d-%H%M%S.ts` */
export const SEGMENT_STRFTIME_SUFFIX = '%Y%m%d-%H%M%S.ts'

export function isRecordingMediaFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.ts') || lower.endsWith('.mp4') || lower.endsWith('.mkv')
}

export function formatSegmentTimeRange(startMs: number | null, endMs: number | null): string {
  if (startMs == null && endMs == null) return '—'
  const fmt = (ms: number) => {
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  if (startMs != null && endMs != null) return `${fmt(startMs)} – ${fmt(endMs)}`
  if (startMs != null) return `${fmt(startMs)} –`
  return `– ${fmt(endMs!)}`
}

/** Compact clock for timeline block labels (HH:mm or HH:mm:ss). */
export function formatSegmentClock(ms: number, withSeconds = true): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  if (withSeconds) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatSegmentDuration(startMs: number, endMs: number): string {
  const sec = Math.max(0, Math.round((endMs - startMs) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}

export function formatSegmentDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
