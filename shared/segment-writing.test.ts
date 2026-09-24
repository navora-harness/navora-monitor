import { describe, expect, it } from 'vitest'
import { isSegmentWriting, SEGMENT_WRITING_FRESH_MS } from './segment-writing'

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
