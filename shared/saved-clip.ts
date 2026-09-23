/** Pure helpers for Tesla-style saved-clip window selection */

/** True if [a0,a1] overlaps [b0,b1] (inclusive endpoints). */
export function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1
}

/**
 * Whether a segment estimated as [endMs - segmentTimeSec*1000, endMs]
 * overlaps the save window [windowEndMs - durationSec*1000, windowEndMs].
 */
export function segmentInSaveWindow(opts: {
  endMs: number
  segmentTimeSec: number
  windowEndMs: number
  durationSec: number
}): boolean {
  const segEnd = opts.endMs
  const segStart = segEnd - Math.max(1, opts.segmentTimeSec) * 1000
  const winEnd = opts.windowEndMs
  const winStart = winEnd - Math.max(1, opts.durationSec) * 1000
  return rangesOverlap(segStart, segEnd, winStart, winEnd)
}
