import { describe, expect, it } from 'vitest'
import {
  estimateSegmentBounds,
  isCachedRangePlausible,
  isSparseTimeline,
  recentActivityRange,
  trimOverlappingSegmentEnds,
} from './segment-range'

describe('estimateSegmentBounds', () => {
  const start = new Date(2026, 8, 24, 10, 0, 0).getTime()

  it('uses probed duration from the media file as primary', () => {
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: start + 320_000,
      probedDurationMs: 295_000,
      segmentTimeSec: 300,
      sizeBytes: 40_000_000,
      nowMs: start + 3600_000,
    })
    expect(r.startMs).toBe(start)
    expect(r.endMs).toBe(start + 295_000)
  })

  it('falls back to wall-clock when probe is missing', () => {
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: start + 310_000,
      probedDurationMs: null,
      segmentTimeSec: 300,
      sizeBytes: 40_000_000,
      nowMs: start + 3600_000,
    })
    expect(r.endMs - r.startMs).toBe(310_000)
  })

  it('rejects impossible long probe for a small file and uses wall clock', () => {
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: start + 310_000,
      probedDurationMs: 12 * 3600_000,
      segmentTimeSec: 300,
      sizeBytes: 40_000_000,
      nowMs: start + 3600_000,
    })
    expect(r.endMs - r.startMs).toBe(310_000)
  })

  it('keeps a real multi-hour file when mtime spans hours and probe is null', () => {
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: start + 2 * 3600_000,
      probedDurationMs: null,
      segmentTimeSec: 300,
      sizeBytes: 900_000_000,
      nowMs: start + 3 * 3600_000,
    })
    expect(r.endMs - r.startMs).toBe(2 * 3600_000)
  })

  it('uses probed multi-hour duration when the file data says so', () => {
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: start + 2 * 3600_000 + 5_000,
      probedDurationMs: 2 * 3600_000,
      segmentTimeSec: 300,
      sizeBytes: 900_000_000,
      nowMs: start + 3 * 3600_000,
    })
    expect(r.endMs - r.startMs).toBe(2 * 3600_000)
  })

  it('uses mtime for a recently written growing file', () => {
    const now = start + 2 * 3600_000
    const r = estimateSegmentBounds({
      parsedStartMs: start,
      mtimeMs: now - 5_000,
      probedDurationMs: null,
      segmentTimeSec: 300,
      sizeBytes: 500_000_000,
      nowMs: now,
    })
    expect(r.endMs).toBe(now - 5_000)
  })
})

describe('trimOverlappingSegmentEnds', () => {
  it('caps end at next start', () => {
    const a = { startMs: 1000, endMs: 9000 }
    const b = { startMs: 4000, endMs: 7000 }
    const out = trimOverlappingSegmentEnds([a, b])
    expect(out[0]!.endMs).toBe(4000)
  })
})

describe('recentActivityRange / sparse', () => {
  it('picks the latest cluster', () => {
    const morning = { startMs: 0, endMs: 600_000 }
    const evening = { startMs: 10 * 3600_000, endMs: 10 * 3600_000 + 900_000 }
    const r = recentActivityRange([morning, evening], 20 * 60_000)
    expect(r?.startMs).toBe(evening.startMs)
    expect(r?.endMs).toBe(evening.endMs)
  })

  it('detects sparse day-long span', () => {
    const segs = [
      { startMs: 0, endMs: 600_000 },
      { startMs: 12 * 3600_000, endMs: 12 * 3600_000 + 600_000 },
    ]
    expect(isSparseTimeline(segs, 12 * 3600_000 + 600_000)).toBe(true)
  })
})

describe('isCachedRangePlausible', () => {
  it('rejects short-capped cache for a large file', () => {
    const start = 1_000_000
    expect(
      isCachedRangePlausible(
        { startMs: start, endMs: start + 300_000, sizeBytes: 400_000_000, durationMs: 300_000 },
        400_000_000,
        300,
        start + 2 * 3600_000,
        start + 3 * 3600_000,
      ),
    ).toBe(false)
  })

  it('accepts a long real-duration cache', () => {
    const start = 1_000_000
    expect(
      isCachedRangePlausible(
        {
          startMs: start,
          endMs: start + 2 * 3600_000,
          sizeBytes: 900_000_000,
          durationMs: 2 * 3600_000,
        },
        900_000_000,
        300,
        start + 2 * 3600_000,
        start + 3 * 3600_000,
      ),
    ).toBe(true)
  })
})
