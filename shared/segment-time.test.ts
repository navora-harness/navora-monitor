import { describe, expect, it } from 'vitest'
import {
  formatSegmentClock,
  formatSegmentDuration,
  formatSegmentTimeRange,
  parseSegmentStartMs,
} from './segment-time'

describe('parseSegmentStartMs', () => {
  it('parses strftime segment names', () => {
    const ms = parseSegmentStartMs('Cafe_East-20260924-061530.mp4')
    expect(ms).not.toBeNull()
    const d = new Date(ms!)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(8)
    expect(d.getDate()).toBe(24)
    expect(d.getHours()).toBe(6)
    expect(d.getMinutes()).toBe(15)
    expect(d.getSeconds()).toBe(30)
  })

  it('returns null for legacy numeric suffixes', () => {
    expect(parseSegmentStartMs('Cafe_East-001.mp4')).toBeNull()
  })
  it('recognizes unique saved clip filenames without losing capture time', () => {
    expect(parseSegmentStartMs('clip-20261011-235958-a1b2c3d4e5f60718.mp4')).toBe(new Date(2026, 9, 11, 23, 59, 58).getTime())
  })
})

describe('formatSegmentTimeRange', () => {
  it('formats a range', () => {
    const a = new Date(2026, 8, 24, 6, 15, 0).getTime()
    const b = new Date(2026, 8, 24, 6, 20, 0).getTime()
    expect(formatSegmentTimeRange(a, b)).toBe('06:15:00 – 06:20:00')
  })
})

describe('formatSegmentClock / duration', () => {
  it('formats clock and duration', () => {
    const a = new Date(2026, 8, 24, 6, 15, 30).getTime()
    const b = a + 125_000
    expect(formatSegmentClock(a, true)).toBe('06:15:30')
    expect(formatSegmentClock(a, false)).toBe('06:15')
    expect(formatSegmentDuration(a, b)).toBe('2m5s')
  })
})
