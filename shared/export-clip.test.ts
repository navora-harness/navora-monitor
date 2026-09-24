import { describe, expect, it } from 'vitest'
import {
  concatSeekAndDuration,
  formatExportStamp,
  segmentsOverlappingRange,
} from './export-clip'

describe('segmentsOverlappingRange', () => {
  const segs = [
    { path: '/a', fileName: 'a', startMs: 1000, endMs: 4000 },
    { path: '/b', fileName: 'b', startMs: 4000, endMs: 7000 },
    { path: '/c', fileName: 'c', startMs: 9000, endMs: 12000 },
  ]

  it('picks overlapping segments in order', () => {
    const hit = segmentsOverlappingRange(segs, 3500, 5000)
    expect(hit.map((s) => s.fileName)).toEqual(['a', 'b'])
  })

  it('returns empty when no overlap', () => {
    expect(segmentsOverlappingRange(segs, 7500, 8000)).toEqual([])
  })
})

describe('concatSeekAndDuration', () => {
  it('computes seek from first segment', () => {
    const ordered = [
      { path: '/a', fileName: 'a', startMs: 1000, endMs: 4000 },
      { path: '/b', fileName: 'b', startMs: 4000, endMs: 7000 },
    ]
    const r = concatSeekAndDuration(ordered, 2500, 5500)
    expect(r).toEqual({ seekSec: 1.5, durationSec: 3 })
  })
})

describe('formatExportStamp', () => {
  it('formats local stamp', () => {
    const ms = new Date(2026, 8, 24, 6, 15, 30).getTime()
    expect(formatExportStamp(ms)).toBe('20260924-061530')
  })
})
