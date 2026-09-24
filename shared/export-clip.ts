/** Pure helpers for time-range clip export / merge. */

import { rangesOverlap } from './saved-clip'

export type TimedSegment = {
  path: string
  fileName: string
  startMs: number
  endMs: number
}

/** Segments that overlap [rangeStartMs, rangeEndMs], chronological. */
export function segmentsOverlappingRange<T extends TimedSegment>(
  segments: T[],
  rangeStartMs: number,
  rangeEndMs: number,
): T[] {
  const a = Math.min(rangeStartMs, rangeEndMs)
  const b = Math.max(rangeStartMs, rangeEndMs)
  if (!(b > a)) return []
  return segments
    .filter((s) => rangesOverlap(s.startMs, s.endMs, a, b))
    .sort((x, y) => x.startMs - y.startMs || x.fileName.localeCompare(y.fileName))
}

/**
 * Seek offset (sec) into the concatenated stream from the first segment start,
 * and output duration (sec) for the requested wall-clock window.
 */
export function concatSeekAndDuration(
  ordered: TimedSegment[],
  rangeStartMs: number,
  rangeEndMs: number,
): { seekSec: number; durationSec: number } | null {
  if (!ordered.length) return null
  const a = Math.min(rangeStartMs, rangeEndMs)
  const b = Math.max(rangeStartMs, rangeEndMs)
  const first = ordered[0]!
  const seekSec = Math.max(0, (a - first.startMs) / 1000)
  const durationSec = Math.max(0.2, (b - a) / 1000)
  return { seekSec, durationSec }
}

export function formatExportStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
