/** Detect segments still being written (unplayable until finalize). */

/** Match VOD playlist skip window — files touched this recently are held out of HLS. */
export const SEGMENT_WRITING_FRESH_MS = 12_000

export function isSegmentWriting(
  seg: { mtimeMs: number },
  nowMs: number = Date.now(),
): boolean {
  if (!Number.isFinite(seg.mtimeMs) || !(seg.mtimeMs > 0)) return false
  return nowMs - seg.mtimeMs < SEGMENT_WRITING_FRESH_MS
}
