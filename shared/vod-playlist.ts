/** Pure HLS VOD playlist builder (wall-clock indexed MPEG-TS segments). */

export type VodSeg = {
  fileName: string
  startMs: number
  endMs: number
  /** Optional size for playability filtering */
  sizeBytes?: number
}

/** Tiny / truncated TS fragments that break HLS (often missing keyframe / PAT). */
export function isFragileTsSegment(seg: {
  startMs: number
  endMs: number
  sizeBytes?: number | null
}): boolean {
  const durMs = Math.max(0, seg.endMs - seg.startMs)
  const size = seg.sizeBytes ?? null
  // Extremely short wall span
  if (durMs > 0 && durMs < 12_000) return true
  // Tiny on disk (incomplete remux after reconnect)
  if (size != null && size > 0 && size < 180_000) return true
  // Implausibly low bitrate for video
  if (size != null && size > 0 && durMs >= 12_000) {
    const bps = (size * 8) / (durMs / 1000)
    if (bps < 80_000) return true
  }
  return false
}

export function isHlsFriendlyTsSegment(seg: {
  fileName: string
  startMs: number
  endMs: number
  sizeBytes?: number | null
}): boolean {
  if (!isMpegTsFileName(seg.fileName)) return false
  if (!(seg.endMs > seg.startMs)) return false
  return !isFragileTsSegment(seg)
}

export type VodPlaylistOpts = {
  channelId: string
  /** Absolute media prefix, e.g. `/recordings/ch` or `/media/recordings/ch` */
  mediaPrefix: string
  segments: VodSeg[]
  /** Skip files still being written (mtime too recent). */
  skipFileNames?: Set<string>
  /** Gap larger than this inserts EXT-X-DISCONTINUITY (default 3s). */
  gapMs?: number
  /** Max segments in one playlist (default 48 ≈ 4h at 5min). */
  maxSegments?: number
}

export type VodPlaylistResult = {
  body: string
  windowStartMs: number
  windowEndMs: number
  segmentCount: number
}

/** ISO-8601 for EXT-X-PROGRAM-DATE-TIME (local offset). */
export function formatProgramDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const y = d.getFullYear()
  const mo = p(d.getMonth() + 1)
  const day = p(d.getDate())
  const h = p(d.getHours())
  const mi = p(d.getMinutes())
  const s = p(d.getSeconds())
  const ms3 = String(d.getMilliseconds()).padStart(3, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  const tzh = p(Math.floor(abs / 60))
  const tzm = p(abs % 60)
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${ms3}${sign}${tzh}:${tzm}`
}

export function isMpegTsFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.ts')
}

/**
 * Build a VOD m3u8 from timed .ts segments overlapping [startMs, endMs].
 * Segment URIs are `${mediaPrefix}/${encodeURIComponent(fileName)}`.
 */
export function buildVodM3u8(
  rangeStartMs: number,
  rangeEndMs: number,
  opts: VodPlaylistOpts,
): VodPlaylistResult | null {
  const a = Math.min(rangeStartMs, rangeEndMs)
  const b = Math.max(rangeStartMs, rangeEndMs)
  if (!(b > a)) return null

  const gapMs = opts.gapMs ?? 3000
  const maxSeg = Math.max(1, opts.maxSegments ?? 48)
  const skip = opts.skipFileNames

  let list = opts.segments
    .filter((s) => isHlsFriendlyTsSegment(s))
    .filter((s) => s.startMs < b && s.endMs > a)
    .filter((s) => !skip?.has(s.fileName))
    .sort((x, y) => x.startMs - y.startMs || x.fileName.localeCompare(y.fileName))

  if (!list.length) return null
  if (list.length > maxSeg) {
    // Prefer segments nearest the window center
    const mid = (a + b) / 2
    list = [...list]
      .sort(
        (x, y) =>
          Math.abs((x.startMs + x.endMs) / 2 - mid) - Math.abs((y.startMs + y.endMs) / 2 - mid),
      )
      .slice(0, maxSeg)
      .sort((x, y) => x.startMs - y.startMs)
  }

  let maxDur = 1
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ]

  let prevEnd: number | null = null
  let windowStart = list[0]!.startMs
  let windowEnd = list[0]!.endMs

  for (const seg of list) {
    const durSec = Math.max(0.2, (seg.endMs - seg.startMs) / 1000)
    maxDur = Math.max(maxDur, Math.ceil(durSec))
    windowStart = Math.min(windowStart, seg.startMs)
    windowEnd = Math.max(windowEnd, seg.endMs)

    if (prevEnd != null && seg.startMs - prevEnd > gapMs) {
      lines.push('#EXT-X-DISCONTINUITY')
    }
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${formatProgramDateTime(seg.startMs)}`)
    lines.push(`#EXTINF:${durSec.toFixed(3)},`)
    const prefix = opts.mediaPrefix.replace(/\/$/, '')
    lines.push(`${prefix}/${encodeURIComponent(seg.fileName)}`)
    prevEnd = seg.endMs
  }

  // Insert TARGETDURATION after header block
  lines.splice(4, 0, `#EXT-X-TARGETDURATION:${maxDur}`)
  lines.push('#EXT-X-ENDLIST')

  return {
    body: lines.join('\n') + '\n',
    windowStartMs: windowStart,
    windowEndMs: windowEnd,
    segmentCount: list.length,
  }
}

/** Default playback window around a wall-clock center (±20 min). */
export function defaultVodWindow(centerMs: number, halfSpanMs = 20 * 60_000): {
  startMs: number
  endMs: number
} {
  return {
    startMs: centerMs - halfSpanMs,
    endMs: centerMs + halfSpanMs,
  }
}

/**
 * Media time (seconds from playlist start, discontinuity-aware linear) → wall ms
 * using cumulative EXTINF durations and PDT anchors.
 */
export function wallMsFromPlaylistMediaTime(
  segments: VodSeg[],
  mediaSec: number,
  gapMs = 3000,
): number | null {
  if (!segments.length) return null
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  let cursor = 0
  let prevEnd: number | null = null
  for (const seg of sorted) {
    const dur = Math.max(0.2, (seg.endMs - seg.startMs) / 1000)
    // Discontinuities don't add gap time to media timeline in HLS (media jumps)
    if (prevEnd != null && seg.startMs - prevEnd > gapMs) {
      /* discontinuity — media timeline continues without wall gap */
    }
    if (mediaSec < cursor + dur) {
      const into = Math.max(0, mediaSec - cursor)
      return seg.startMs + into * 1000
    }
    cursor += dur
    prevEnd = seg.endMs
  }
  const last = sorted[sorted.length - 1]!
  return last.endMs
}

/** Wall ms → media seconds into the continuous HLS timeline for these segments. */
export function mediaSecFromWallMs(segments: VodSeg[], wallMs: number, gapMs = 3000): number | null {
  if (!segments.length) return null
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  let cursor = 0
  let prevEnd: number | null = null
  for (const seg of sorted) {
    const dur = Math.max(0.2, (seg.endMs - seg.startMs) / 1000)
    if (prevEnd != null && seg.startMs - prevEnd > gapMs) {
      /* discontinuity */
    }
    if (wallMs >= seg.startMs && wallMs <= seg.endMs) {
      return cursor + (wallMs - seg.startMs) / 1000
    }
    // Before this segment after a gap — snap to segment start
    if (wallMs < seg.startMs) {
      return cursor
    }
    cursor += dur
    prevEnd = seg.endMs
  }
  // After last segment
  return Math.max(0, cursor - 0.05)
}
