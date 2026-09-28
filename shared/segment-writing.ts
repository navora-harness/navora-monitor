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

/** How long an open segment may run before it is no longer the live bar. */
export const OPEN_SEGMENT_MAX_MS = 20 * 60_000

/**
 * Timeline gray bar for the file FFmpeg is still writing.
 * Directory mtime on Windows often stays put between flushes, so a 12s
 * mtime check hides the live edge while the file is still growing.
 */
export function isOpenTimelineSegment(
  seg: { mtimeMs: number; protected?: boolean },
  opts: { newest: boolean; startMs: number; nowMs: number; channelRecording?: boolean },
): boolean {
  if (seg.protected) return false
  const now = opts.nowMs
  const start = opts.startMs
  if (!Number.isFinite(start) || now < start || now - start > OPEN_SEGMENT_MAX_MS) return false
  if (isSegmentWriting(seg, now)) return true
  if (!opts.newest) return false
  if (opts.channelRecording) return true
  return Number.isFinite(seg.mtimeMs) && now - seg.mtimeMs < 120_000
}
