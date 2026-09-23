import { describe, expect, it } from 'vitest'
import { isScheduleActive, parseHm, sanitizeSchedule } from './schedule'

describe('parseHm', () => {
  it('parses HH:mm', () => {
    expect(parseHm('08:30')).toBe(8 * 60 + 30)
    expect(parseHm('23:59')).toBe(23 * 60 + 59)
    expect(parseHm('bad')).toBeNull()
  })
})

describe('isScheduleActive', () => {
  it('handles same-day window', () => {
    const s = sanitizeSchedule({
      enabled: true,
      days: [1],
      start: '09:00',
      end: '18:00',
    })!
    // Monday 10:00
    expect(isScheduleActive(s, new Date('2026-09-21T10:00:00'))).toBe(true)
    expect(isScheduleActive(s, new Date('2026-09-21T08:00:00'))).toBe(false)
    // Sunday
    expect(isScheduleActive(s, new Date('2026-09-20T10:00:00'))).toBe(false)
  })

  it('handles overnight window', () => {
    const s = sanitizeSchedule({
      enabled: true,
      days: [1],
      start: '22:00',
      end: '06:00',
    })!
    expect(isScheduleActive(s, new Date('2026-09-21T23:00:00'))).toBe(true)
    expect(isScheduleActive(s, new Date('2026-09-21T03:00:00'))).toBe(true)
    expect(isScheduleActive(s, new Date('2026-09-21T12:00:00'))).toBe(false)
  })
})
