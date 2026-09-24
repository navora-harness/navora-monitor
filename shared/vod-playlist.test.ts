import { describe, expect, it } from 'vitest'
import {
  buildVodM3u8,
  defaultVodWindow,
  formatProgramDateTime,
  isFragileTsSegment,
  isHlsFriendlyTsSegment,
  mediaSecFromWallMs,
  wallMsFromPlaylistMediaTime,
  type VodSeg,
} from './vod-playlist'

const base = 7 * 3600_000
const segs: VodSeg[] = [
  { fileName: 'a.ts', startMs: base, endMs: base + 300_000, sizeBytes: 40_000_000 },
  { fileName: 'b.ts', startMs: base + 600_000, endMs: base + 900_000, sizeBytes: 40_000_000 },
]

describe('buildVodM3u8', () => {
  it('emits PDT, DISCONTINUITY across gaps, and ENDLIST', () => {
    const r = buildVodM3u8(base - 60_000, base + 1_000_000, {
      channelId: 'cam1',
      mediaPrefix: '/recordings/cam1',
      segments: segs,
    })
    expect(r).not.toBeNull()
    const body = r!.body
    expect(body).toContain('#EXTM3U')
    expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD')
    expect(body).toContain('#EXT-X-ENDLIST')
    expect(body).toContain('#EXT-X-DISCONTINUITY')
    expect(body).toContain('#EXT-X-PROGRAM-DATE-TIME:')
    expect(body).toContain('/recordings/cam1/a.ts')
    expect(body).toContain('/recordings/cam1/b.ts')
    expect(body).toMatch(/#EXT-X-TARGETDURATION:\d+/)
  })

  it('skips non-ts and skipFileNames', () => {
    const r = buildVodM3u8(base, base + 1_000_000, {
      channelId: 'cam1',
      mediaPrefix: '/recordings/cam1',
      segments: [
        ...segs,
        { fileName: 'x.mp4', startMs: base, endMs: base + 100_000 },
      ],
      skipFileNames: new Set(['a.ts']),
    })
    expect(r).not.toBeNull()
    expect(r!.body).not.toContain('a.ts')
    expect(r!.body).not.toContain('x.mp4')
    expect(r!.body).toContain('b.ts')
  })

  it('excludes fragile short / tiny TS from HLS playlist', () => {
    const r = buildVodM3u8(base - 60_000, base + 1_000_000, {
      channelId: 'cam1',
      mediaPrefix: '/recordings/cam1',
      segments: [
        ...segs,
        { fileName: 'short.ts', startMs: base + 300_000, endMs: base + 308_000, sizeBytes: 50_000 },
        { fileName: 'tiny.ts', startMs: base + 310_000, endMs: base + 610_000, sizeBytes: 40_000 },
      ],
    })
    expect(r).not.toBeNull()
    expect(r!.body).toContain('a.ts')
    expect(r!.body).toContain('b.ts')
    expect(r!.body).not.toContain('short.ts')
    expect(r!.body).not.toContain('tiny.ts')
  })
})

describe('isFragileTsSegment', () => {
  it('flags short wall span and tiny files', () => {
    expect(isFragileTsSegment({ startMs: 0, endMs: 8_000, sizeBytes: 5_000_000 })).toBe(true)
    expect(isFragileTsSegment({ startMs: 0, endMs: 300_000, sizeBytes: 50_000 })).toBe(true)
    expect(isFragileTsSegment({ startMs: 0, endMs: 300_000, sizeBytes: 40_000_000 })).toBe(false)
  })

  it('isHlsFriendly requires .ts and non-fragile', () => {
    expect(
      isHlsFriendlyTsSegment({
        fileName: 'a.ts',
        startMs: 0,
        endMs: 300_000,
        sizeBytes: 40_000_000,
      }),
    ).toBe(true)
    expect(
      isHlsFriendlyTsSegment({
        fileName: 'a.mp4',
        startMs: 0,
        endMs: 300_000,
        sizeBytes: 40_000_000,
      }),
    ).toBe(false)
  })
})

describe('window + media mapping', () => {
  it('defaultVodWindow is ±halfSpan', () => {
    const w = defaultVodWindow(1000, 500)
    expect(w.startMs).toBe(500)
    expect(w.endMs).toBe(1500)
  })

  it('maps wall ↔ media across discontinuity', () => {
    const midA = base + 60_000
    const sec = mediaSecFromWallMs(segs, midA)
    expect(sec).toBeCloseTo(60, 5)
    expect(wallMsFromPlaylistMediaTime(segs, sec!)).toBeCloseTo(midA, 0)

    const midB = base + 600_000 + 30_000
    const secB = mediaSecFromWallMs(segs, midB)
    // After first 300s segment
    expect(secB).toBeCloseTo(300 + 30, 5)
    expect(wallMsFromPlaylistMediaTime(segs, secB!)).toBeCloseTo(midB, 0)
  })

  it('formatProgramDateTime includes timezone', () => {
    const s = formatProgramDateTime(base)
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  })
})
