import { describe, expect, it } from 'vitest'
import {
  MediaTimeBase,
  clipToWallMs,
  effectiveDurationSec,
  nextClip,
  sortClipsAsc,
  wallToClip,
  type TimedClip,
} from './wall-time'

const clips: TimedClip[] = sortClipsAsc([
  { id: 'a', startMs: 7 * 3600_000, endMs: 7 * 3600_000 + 300_000, url: '/a.ts', fileName: 'a.ts' },
  { id: 'b', startMs: 8 * 3600_000, endMs: 8 * 3600_000 + 300_000, url: '/b.ts', fileName: 'b.ts' },
])

describe('wallToClip', () => {
  it('hits inside a segment', () => {
    const hit = wallToClip(clips, 7 * 3600_000 + 60_000)
    expect(hit.kind).toBe('inside')
    if (hit.kind === 'inside') {
      expect(hit.clip.id).toBe('a')
      expect(hit.offsetSec).toBe(60)
    }
  })

  it('snaps gaps to nearest segment edge', () => {
    const hit = wallToClip(clips, 7.5 * 3600_000)
    expect(hit.kind).toBe('gap')
    if (hit.kind === 'gap') {
      // Midway between A end (7h+5m) and B start (8h) — closer to A end
      expect(hit.nearest.id).toBe('a')
      expect(hit.offsetSec).toBeCloseTo(300, 0)
    }
  })
})

describe('clipToWallMs / nextClip', () => {
  it('clamps wall to clip bounds', () => {
    const c = clips[0]!
    expect(clipToWallMs(c, -1)).toBe(c.startMs)
    expect(clipToWallMs(c, 9999)).toBe(c.endMs)
  })

  it('finds next clip', () => {
    expect(nextClip(clips, 'a')?.id).toBe('b')
    expect(nextClip(clips, 'b')).toBeNull()
  })
})

describe('effectiveDurationSec', () => {
  it('rejects absurd PCR durations', () => {
    expect(effectiveDurationSec(300, 86_400)).toBe(300)
    expect(effectiveDurationSec(300, 280)).toBe(280)
  })
})

describe('MediaTimeBase', () => {
  it('calibrates PCR origin from seeked', () => {
    const b = new MediaTimeBase()
    b.calibrateFromSeeked(25_200, 0)
    expect(b.isLocked).toBe(true)
    expect(b.relativeSec(25_260)).toBeCloseTo(60, 5)
    expect(b.absoluteSec(10)).toBeCloseTo(25_210, 5)
  })

  it('does not rebase after seek calibration when PCR jumps', () => {
    const b = new MediaTimeBase()
    b.calibrateFromSeeked(25_200, 120)
    expect(b.relativeSec(25_200)).toBeCloseTo(120, 5)
    // Large PCR-looking values must not reset to 0 once locked
    expect(b.relativeSec(25_260)).toBeCloseTo(180, 5)
  })

  it('observes origin without locking until calibrate', () => {
    const b = new MediaTimeBase()
    expect(b.relativeSec(0.05)).toBe(0)
    expect(b.isLocked).toBe(false)
    // Unlocked near-zero origin: large PCR-like jump rebases to 0
    expect(b.relativeSec(25_200)).toBe(0)
    b.calibrateFromSeeked(25_260, 60)
    expect(b.isLocked).toBe(true)
    expect(b.relativeSec(25_320)).toBeCloseTo(120, 5)
  })
})
