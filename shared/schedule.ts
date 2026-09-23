import type { ChannelSchedule } from './types'

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function parseHm(raw: string): number | null {
  const m = TIME_RE.exec(raw.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function sanitizeSchedule(raw: Partial<ChannelSchedule> | null | undefined): ChannelSchedule | undefined {
  if (!raw || raw.enabled !== true) return undefined
  const days = Array.isArray(raw.days)
    ? [...new Set(raw.days.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))]
    : [0, 1, 2, 3, 4, 5, 6]
  if (!days.length) return undefined
  const start = typeof raw.start === 'string' && parseHm(raw.start) != null ? raw.start.trim() : '00:00'
  const end = typeof raw.end === 'string' && parseHm(raw.end) != null ? raw.end.trim() : '23:59'
  return { enabled: true, days, start, end }
}

/** Whether now falls inside the schedule window (supports overnight ranges). */
export function isScheduleActive(schedule: ChannelSchedule | undefined, now = new Date()): boolean {
  if (!schedule?.enabled) return false
  const day = now.getDay()
  if (!schedule.days.includes(day)) return false
  const start = parseHm(schedule.start)
  const end = parseHm(schedule.end)
  if (start == null || end == null) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  if (start === end) return true // 24h
  if (start < end) return mins >= start && mins < end
  // overnight e.g. 22:00–06:00
  return mins >= start || mins < end
}
