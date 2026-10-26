import { describe, expect, it } from 'vitest'
import { isOpenTimelineSegment, isSegmentWriting, SEGMENT_WRITING_FRESH_MS, timelineSegmentEnd } from './segment-writing'

describe('timelineSegmentEnd', () => {
  it('ends an open recording at now instead of its predicted end', () => {
    expect(timelineSegmentEnd(1000, 301000, 61000, true)).toBe(61000)
    expect(timelineSegmentEnd(1000, 2000, 61000, true)).toBe(61000)
    expect(timelineSegmentEnd(1000, 301000, 61000, false)).toBe(301000)
  })
})

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

  it('uses explicit lifecycle even with stale mtime or a running channel', () => {
    const opts = { newest: true, startMs: now-60*60_000, nowMs: now, channelRecording: true }
    expect(isOpenTimelineSegment({ mtimeMs: now, state: 'ready' }, opts)).toBe(false)
    expect(isOpenTimelineSegment({ mtimeMs: now-60*60_000, state: 'writing' }, opts)).toBe(true)
    expect(isOpenTimelineSegment({ mtimeMs: now, state: 'invalid' }, opts)).toBe(false)
  })

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
