/** Wall-clock range helpers for recording segments on the timeline. */

export type TimedRange = {
  startMs: number
  endMs: number
}

/** Configured segment length — soft hint, not a hard cap on real files. */
export function nominalSegmentMs(segmentTimeSec: number): number {
  return Math.max(10, segmentTimeSec) * 1000
}

/** Soft overrun allowance past configured segment length. */
export function maxPlausibleSegmentMs(segmentTimeSec: number): number {
  return Math.round(nominalSegmentMs(segmentTimeSec) * 2.5)
}

/**
 * Hard ceiling for a single segment bar (guards against absurd probes).
 * Real DVR segments should never need more than a day on one file.
 */
const ABSOLUTE_MAX_SEGMENT_MS = 24 * 3600_000

/** Reject duration estimates that imply impossible bitrates for the file size. */
function durationFitsSize(durationMs: number, sizeBytes: number | null | undefined): boolean {
  if (sizeBytes == null || !(sizeBytes > 0) || !(durationMs > 0)) return true
  const bps = sizeBytes / (durationMs / 1000)
  // > ~80 Mbps average → duration almost certainly too short for this file
  if (bps > 10_000_000) return false
  // Tiny files claiming multi-hour duration are also suspicious
  if (durationMs > 3600_000 && sizeBytes < 64_000) return false
  // Very long duration with tiny bitrate (< ~80 kbps) — typical bogus MPEG-TS probe
  if (durationMs > 30 * 60_000 && bps < 10_000) return false
  return true
}

/**
 * Estimate [start, end] for one segment file.
 *
 * Prefer real media duration from ffprobe/ffmpeg when available.
 * Fall back to wall-clock (filename start → mtime) for containers that
 * omit duration (common for MPEG-TS cut mid-GOP).
 */
export function estimateSegmentBounds(opts: {
  parsedStartMs: number | null
  mtimeMs: number
  probedDurationMs: number | null
  segmentTimeSec: number
  sizeBytes?: number | null
  nowMs?: number
}): TimedRange {
  const now = opts.nowMs ?? Date.now()
  const nominal = nominalSegmentMs(opts.segmentTimeSec)
  const recentlyWritten = now - opts.mtimeMs < 90_000
  const size = opts.sizeBytes ?? null

  const probed =
    opts.probedDurationMs != null &&
    opts.probedDurationMs > 0 &&
    opts.probedDurationMs <= ABSOLUTE_MAX_SEGMENT_MS &&
    durationFitsSize(opts.probedDurationMs, size)
      ? opts.probedDurationMs
      : null

  if (opts.parsedStartMs != null) {
    const startMs = opts.parsedStartMs
    const wallMs =
      opts.mtimeMs > startMs && opts.mtimeMs - startMs <= ABSOLUTE_MAX_SEGMENT_MS
        ? opts.mtimeMs - startMs
        : null

    // Growing file: mtime is the live end
    if (recentlyWritten && wallMs != null) {
      // If probe already has a usable length, take the larger of probe/wall
      if (probed != null) {
        return { startMs, endMs: startMs + Math.max(probed, wallMs) }
      }
      return { startMs, endMs: Math.max(opts.mtimeMs, startMs + 500) }
    }

    // Primary: duration read from the media file
    if (probed != null) {
      return { startMs, endMs: startMs + probed }
    }

    // Fallback: wall clock (mtime − filename start)
    if (wallMs != null && durationFitsSize(wallMs, size)) {
      return { startMs, endMs: startMs + wallMs }
    }

    let endMs = startMs + nominal
    if (opts.mtimeMs > startMs && opts.mtimeMs - startMs < nominal * 2) {
      endMs = Math.max(endMs, opts.mtimeMs)
    }
    if (endMs <= startMs) endMs = startMs + 1000
    return { startMs, endMs }
  }

  const endMs = opts.mtimeMs
  let duration = probed ?? nominal
  if (!durationFitsSize(duration, size) && size != null && size > 0) {
    duration = Math.min(ABSOLUTE_MAX_SEGMENT_MS, Math.max(nominal, Math.round((size * 8) / 2_000_000) * 1000))
  }
  let startMs = endMs - duration
  if (startMs >= endMs) startMs = endMs - 1000
  return { startMs, endMs }
}

/** Whether a cached index entry looks trustworthy for the current settings. */
export function isCachedRangePlausible(
  cached: TimedRange & { sizeBytes: number; durationMs?: number },
  sizeBytes: number,
  segmentTimeSec: number,
  mtimeMs: number,
  nowMs = Date.now(),
): boolean {
  if (cached.sizeBytes !== sizeBytes) return false
  if (!(cached.endMs > cached.startMs)) return false
  const dur = cached.endMs - cached.startMs
  if (!durationFitsSize(dur, sizeBytes)) return false

  // Invalidate old "capped to ~segmentTime" entries for large files
  const nominal = nominalSegmentMs(segmentTimeSec)
  const softMax = maxPlausibleSegmentMs(segmentTimeSec)
  if (dur <= softMax && sizeBytes >= Math.max(8_000_000, (nominal / 1000) * 250_000)) {
    // ≥ ~2 Mbps for a full nominal segment, yet duration stuck near segmentTime —
    // likely a previous over-cap; force re-estimate.
    if (dur <= nominal * 1.15) return false
  }

  void mtimeMs
  void nowMs
  return true
}

/**
 * Cap each segment end at the next segment's start when it overshoots
 * (fixes inflated durations that would paint multi-hour bars).
 */
export function trimOverlappingSegmentEnds<T extends TimedRange>(segments: T[]): T[] {
  if (segments.length < 2) return segments
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!
    const next = sorted[i + 1]!
    if (cur.endMs > next.startMs && next.startMs > cur.startMs) {
      cur.endMs = next.startMs
    }
  }
  return sorted
}

/**
 * Latest contiguous activity cluster (gap ≤ gapMs).
 * Used so the timeline fits the recent recording burst instead of an empty all-day span.
 */
export function recentActivityRange(
  segments: TimedRange[],
  gapMs = 20 * 60_000,
): TimedRange | null {
  if (!segments.length) return null
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  const clusters: TimedRange[] = []
  let cStart = sorted[0]!.startMs
  let cEnd = sorted[0]!.endMs
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]!
    if (s.startMs <= cEnd + gapMs) {
      cEnd = Math.max(cEnd, s.endMs)
      cStart = Math.min(cStart, s.startMs)
    } else {
      clusters.push({ startMs: cStart, endMs: cEnd })
      cStart = s.startMs
      cEnd = s.endMs
    }
  }
  clusters.push({ startMs: cStart, endMs: cEnd })
  return clusters[clusters.length - 1] ?? null
}

/** Recorded duration sum vs bounding span — detect sparse all-day layouts. */
export function isSparseTimeline(segments: TimedRange[], spanMs: number): boolean {
  if (!(spanMs > 0) || !segments.length) return false
  let recorded = 0
  for (const s of segments) recorded += Math.max(0, s.endMs - s.startMs)
  // More than 3h on the axis but recordings cover under ~35% of that span
  return spanMs >= 3 * 3600_000 && recorded < spanMs * 0.35
}
