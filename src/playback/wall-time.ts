/** Wall-clock ↔ segment offset mapping (pure, UI-agnostic). */

import type { RecordingSegment } from '@shared/types'

export type TimedClip = {
  id: string
  startMs: number
  endMs: number
  url: string
  fileName: string
}

export function segStartMs(seg: Pick<RecordingSegment, 'startMs' | 'mtimeMs'>): number {
  return seg.startMs ?? seg.mtimeMs
}

export function segEndMs(seg: Pick<RecordingSegment, 'startMs' | 'endMs' | 'mtimeMs'>): number {
  const a = segStartMs(seg)
  return Math.max(a + 500, seg.endMs ?? a)
}

export function segmentSpanSec(seg: Pick<RecordingSegment, 'startMs' | 'endMs' | 'mtimeMs'>): number {
  return Math.max(0.5, (segEndMs(seg) - segStartMs(seg)) / 1000)
}

/** Prefer wall span when HTMLMediaElement.duration is absurd (MPEG-TS PCR). */
export function effectiveDurationSec(wallSpanSec: number, mediaDurationSec: number | null | undefined): number {
  const d = mediaDurationSec
  if (d != null && Number.isFinite(d) && d > 0.5 && d < Math.max(wallSpanSec * 2.5, wallSpanSec + 120)) {
    return d
  }
  return wallSpanSec
}

export function toTimedClip(seg: RecordingSegment): TimedClip {
  return {
    id: seg.id,
    startMs: segStartMs(seg),
    endMs: segEndMs(seg),
    url: seg.playbackUrl || seg.url,
    fileName: seg.fileName,
  }
}

export function sortClipsAsc(clips: TimedClip[]): TimedClip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}

export type WallHit =
  | { kind: 'inside'; clip: TimedClip; offsetSec: number }
  | { kind: 'gap'; nearest: TimedClip; offsetSec: number }
  | { kind: 'empty' }

/** Map wall clock → clip + relative offset; gaps snap to nearest segment start. */
export function wallToClip(clipsAsc: TimedClip[], wallMs: number): WallHit {
  if (!clipsAsc.length) return { kind: 'empty' }

  for (const clip of clipsAsc) {
    if (wallMs >= clip.startMs && wallMs <= clip.endMs) {
      const offsetSec = Math.max(0, (wallMs - clip.startMs) / 1000)
      return { kind: 'inside', clip, offsetSec }
    }
  }

  // Nearest by distance to clip interval (prefer landing on edge, not always start)
  let best = clipsAsc[0]!
  let bestDist = Infinity
  let bestOffset = 0
  for (const c of clipsAsc) {
    let d: number
    let offset: number
    if (wallMs < c.startMs) {
      d = c.startMs - wallMs
      offset = 0
    } else if (wallMs > c.endMs) {
      d = wallMs - c.endMs
      offset = Math.max(0, (c.endMs - c.startMs) / 1000)
    } else {
      d = 0
      offset = Math.max(0, (wallMs - c.startMs) / 1000)
    }
    if (d < bestDist) {
      best = c
      bestDist = d
      bestOffset = offset
    }
  }
  return { kind: 'gap', nearest: best, offsetSec: bestOffset }
}

export function clipToWallMs(clip: TimedClip, offsetSec: number): number {
  const wall = clip.startMs + Math.max(0, offsetSec) * 1000
  return Math.min(clip.endMs, Math.max(clip.startMs, wall))
}

export function nextClip(clipsAsc: TimedClip[], currentId: string): TimedClip | null {
  const i = clipsAsc.findIndex((c) => c.id === currentId)
  if (i < 0 || i >= clipsAsc.length - 1) return null
  return clipsAsc[i + 1] ?? null
}

export function isMpegTsPath(fileNameOrUrl: string): boolean {
  const s = fileNameOrUrl.toLowerCase()
  return s.endsWith('.ts') || s.includes('.ts?') || s.includes('.ts#')
}

/** PCR / non-zero media timeline origin tracker for MPEG-TS. */
export class MediaTimeBase {
  origin: number | null = null
  ready = false
  /** Once calibrated from a seek, never auto-rebase (avoids 7:00 → random jumps). */
  private locked = false

  get isLocked(): boolean {
    return this.locked
  }

  reset() {
    this.origin = null
    this.ready = false
    this.locked = false
  }

  /** After a seek to relative `targetSec`, learn origin from decoder currentTime. */
  calibrateFromSeeked(currentTime: number, targetSec: number) {
    if (!Number.isFinite(currentTime)) return
    this.origin = currentTime - Math.max(0, targetSec)
    this.ready = true
    this.locked = true
  }

  /** Relative seconds from file start. */
  relativeSec(currentTime: number): number {
    if (!Number.isFinite(currentTime)) return 0
    if (!this.ready) {
      this.origin = currentTime
      this.ready = true
      return 0
    }
    // PCR often appears as a huge currentTime after we briefly locked at ~0 at file open
    if (!this.locked && (this.origin ?? 0) < 1 && currentTime > 30) {
      this.origin = currentTime
      return 0
    }
    return Math.max(0, currentTime - (this.origin ?? 0))
  }

  absoluteSec(relativeSec: number): number {
    return (this.origin ?? 0) + Math.max(0, relativeSec)
  }
}
