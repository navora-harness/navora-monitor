import { describe, expect, it } from 'vitest'
import { isOpenTimelineSegment, isSegmentWriting, SEGMENT_WRITING_FRESH_MS } from './segment-writing'

describe('isSegmentWriting', () => {
  it('true when mtime is within fresh window', () => {
    const now = 1_000_000
    expect(isSegmentWriting({ mtimeMs: now - 1000 }, now)).toBe(true)
    expect(isSegmentWriting({ mtimeMs: now - (SEGMENT_WRITING_FRESH_MS - 1) }, now)).toBe(true)
  })

  it('false when mtime is older than fresh window', () => {
    const now = 1_000_000
    expect(isSegmentWriting({ mtimeMs: now - SEGMENT_WRITING_FRESH_MS }, now)).toBe(false)
    expect(isSegmentWriting({ mtimeMs: now - 60_000 }, now)).toBe(false)
  })
})

describe('isOpenTimelineSegment', () => {
  const now = 1_700_000_000_000
  const start = now - 3 * 60_000

  it('keeps the newest recording gray when mtime has not moved', () => {
    expect(
      isOpenTimelineSegment(
        { mtimeMs: start },
        { newest: true, startMs: start, nowMs: now, channelRecording: true },
      ),
    ).toBe(true)
  })

  it('does not gray an older finished file', () => {
    expect(
      isOpenTimelineSegment(
        { mtimeMs: start },
        { newest: false, startMs: start - 600_000, nowMs: now, channelRecording: true },
      ),
    ).toBe(false)
  })
})
