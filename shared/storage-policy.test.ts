import { describe, expect, it } from 'vitest'
import {
  cleanupTargetFreeBytes,
  estimateRemainSec,
  estimateWriteBytesPerSec,
  evaluateStorageLevel,
  formatDurationLabel,
  gbToBytes,
  mergeStorageLevel,
  retentionExceedsCapacity,
  retentionNeedBytes,
} from './storage-policy'

describe('evaluateStorageLevel', () => {
  it('returns ok when above thresholds', () => {
    expect(evaluateStorageLevel(gbToBytes(10), 5, 1)).toBe('ok')
  })

  it('returns warn between stop and warn', () => {
    expect(evaluateStorageLevel(gbToBytes(3), 5, 1)).toBe('warn')
  })

  it('returns critical below stop', () => {
    expect(evaluateStorageLevel(gbToBytes(0.5), 5, 1)).toBe('critical')
  })

  it('ignores zero thresholds', () => {
    expect(evaluateStorageLevel(gbToBytes(0.1), 0, 0)).toBe('ok')
    expect(evaluateStorageLevel(gbToBytes(0.1), 5, 0)).toBe('warn')
  })
})

describe('cleanupTargetFreeBytes', () => {
  it('prefers warn threshold', () => {
    expect(cleanupTargetFreeBytes(5, 1)).toBe(gbToBytes(5))
  })

  it('falls back to stop+1 when warn disabled', () => {
    expect(cleanupTargetFreeBytes(0, 2)).toBe(gbToBytes(3))
  })
})

describe('write-rate capacity prediction', () => {
  it('sums per-session rates after min elapsed', () => {
    // 10 MB over 20s + 20 MB over 40s → 0.5 + 0.5 MB/s
    const rate = estimateWriteBytesPerSec([
      { bytesWritten: 10_000_000, elapsedSec: 20 },
      { bytesWritten: 20_000_000, elapsedSec: 40 },
    ])
    expect(rate).toBeCloseTo(1_000_000, -2)
  })

  it('ignores sessions below min elapsed', () => {
    expect(
      estimateWriteBytesPerSec([{ bytesWritten: 50_000_000, elapsedSec: 5 }], 15),
    ).toBe(0)
  })

  it('estimates remain and retention need', () => {
    const bps = 1_000_000 // 1 MB/s
    expect(estimateRemainSec(gbToBytes(1), bps)).toBeCloseTo(gbToBytes(1) / bps, 0)
    // 1 day at 1 MB/s
    const need = retentionNeedBytes(bps, 1)
    expect(need).toBe(bps * 86400)
    expect(retentionExceedsCapacity(need, gbToBytes(50))).toBe(true)
    expect(retentionExceedsCapacity(need, gbToBytes(100))).toBe(false)
  })

  it('merges capacity warn into warn without critical', () => {
    expect(mergeStorageLevel('ok', true)).toBe('warn')
    expect(mergeStorageLevel('warn', false)).toBe('warn')
    expect(mergeStorageLevel('critical', true)).toBe('critical')
  })

  it('formats duration labels', () => {
    expect(formatDurationLabel(45)).toContain('秒')
    expect(formatDurationLabel(600)).toContain('分钟')
    expect(formatDurationLabel(7200)).toContain('小时')
    expect(formatDurationLabel(86400 * 2)).toContain('天')
  })
})
