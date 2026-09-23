import { describe, expect, it } from 'vitest'
import { rangesOverlap, segmentInSaveWindow } from './saved-clip'

describe('saved-clip window', () => {
  it('detects overlapping ranges', () => {
    expect(rangesOverlap(0, 10, 5, 15)).toBe(true)
    expect(rangesOverlap(0, 10, 10, 20)).toBe(true)
    expect(rangesOverlap(0, 10, 11, 20)).toBe(false)
  })

  it('selects segments that touch the look-back window', () => {
    const now = 1_000_000
    // 5-min segments, save last 10 min
    expect(
      segmentInSaveWindow({
        endMs: now,
        segmentTimeSec: 300,
        windowEndMs: now,
        durationSec: 600,
      }),
    ).toBe(true)
    expect(
      segmentInSaveWindow({
        endMs: now - 700_000,
        segmentTimeSec: 300,
        windowEndMs: now,
        durationSec: 600,
      }),
    ).toBe(false)
  })
})
