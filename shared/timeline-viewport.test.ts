import { describe, expect, it } from 'vitest'
import { anchoredTimelineCenter, clampTimelineScale, MAX_TIMELINE_SPAN_MS, MIN_TIMELINE_SPAN_MS } from './timeline-viewport'

describe('timeline viewport', () => {
  it('keeps zoom within usable time spans on desktop and phone', () => {
    for (const width of [120, 390, 1440, 3840]) {
      for (const scale of [-1, 0, 1e-20, 1e20, NaN]) {
        const span = width / clampTimelineScale(scale, width)
        expect(span).toBeGreaterThanOrEqual(MIN_TIMELINE_SPAN_MS)
        expect(span).toBeLessThanOrEqual(MAX_TIMELINE_SPAN_MS + 0.001)
      }
    }
  })
  it('preserves the pointer time through repeated zoom and reverse zoom', () => {
    const start = 1791763200000
    let center = start, scale = 0.001
    const anchor = 230, time = center + anchor / scale
    for (const factor of [1.3, 1.1, 0.4, 2, 0.7]) {
      const next = scale * factor
      center = anchoredTimelineCenter(center, anchor, scale, next)
      scale = next
      expect(Math.abs(center + anchor / scale - time)).toBeLessThan(0.01)
    }
    expect(anchoredTimelineCenter(start, 0, 0.001, 0.1)).toBe(start)
  })
})
