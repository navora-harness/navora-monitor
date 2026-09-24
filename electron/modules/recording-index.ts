import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingSegment } from '../../shared/types'
import { isRecordingMediaFile, parseSegmentStartMs } from '../../shared/segment-time'
import { isSegmentWriting } from '../../shared/segment-writing'
import {
  estimateSegmentBounds,
  isCachedRangePlausible,
  trimOverlappingSegmentEnds,
} from '../../shared/segment-range'
import {
  channelCacheDir,
  channelRecordDir,
  recordingsRoot,
  recordCacheRoot,
} from './data-root'
import type { MediaServer } from './media-server'
import { resolveFfmpegPath } from './ffmpeg/resolve'
import { probeDurationMs } from './ffmpeg/probe-duration'
import { finalizeSegmentMp4, finalizeSegmentTs } from './ffmpeg/finalize-segment'
import {
  loadSegmentIndex,
  saveSegmentIndex,
  upsertSegmentIndexEntry,
  type SegmentIndexEntry,
} from './segment-index-store'

function estimateRange(
  fileName: string,
  mtimeMs: number,
  sizeBytes: number,
  segmentTimeSec: number,
  cached: SegmentIndexEntry | undefined,
  ffmpegPath: string | null,
  filePath: string,
): { startMs: number; endMs: number; durationMs: number; entry: SegmentIndexEntry | null } {
  if (cached && isCachedRangePlausible(cached, sizeBytes, segmentTimeSec, mtimeMs)) {
    return {
      startMs: cached.startMs,
      endMs: cached.endMs,
      durationMs: cached.durationMs,
      entry: null,
    }
  }

  // Growing file: size increased since last index — soft-extend end by mtime.
  // Avoids re-probing every poll (probe/wall flicker on MPEG-TS).
  const growing =
    cached != null &&
    sizeBytes > cached.sizeBytes &&
    cached.startMs > 0 &&
    Date.now() - mtimeMs < 120_000
  if (growing && cached) {
    const startMs = cached.startMs
    const endMs = Math.max(cached.endMs, mtimeMs, startMs + 500)
    const entry: SegmentIndexEntry = {
      fileName,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      sizeBytes,
      indexedAt: Date.now(),
    }
    return { startMs, endMs, durationMs: entry.durationMs, entry }
  }

  const parsedStart = parseSegmentStartMs(fileName)
  const probed =
    probeDurationMs(filePath, ffmpegPath) ??
    (cached && cached.sizeBytes === sizeBytes && cached.durationMs > 0 ? cached.durationMs : null)

  const { startMs, endMs } = estimateSegmentBounds({
    parsedStartMs: parsedStart,
    mtimeMs,
    probedDurationMs: probed,
    segmentTimeSec,
    sizeBytes,
  })

  const entry: SegmentIndexEntry = {
    fileName,
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
    sizeBytes,
    indexedAt: Date.now(),
  }
  return { startMs, endMs, durationMs: entry.durationMs, entry }
}

function listChannelIds(channelId?: string): string[] {
  if (channelId) return [channelId]
  const ids = new Set<string>()
  for (const root of [
    recordingsRoot(),
    ...(existsSync(recordCacheRoot()) ? [recordCacheRoot()] : []),
  ]) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory()) ids.add(d.name)
    }
  }
  return [...ids]
}

/** Archive + write-cache dirs for a channel (archive first). Always include cache if present. */
function segmentSourceDirs(channelId: string): string[] {
  const dirs = [channelRecordDir(channelId)]
  const cache = channelCacheDir(channelId)
  if (existsSync(cache)) dirs.push(cache)
  return dirs
}

export function listRecordingSegments(
  media: MediaServer,
  channelId?: string,
  segmentTimeSec = 300,
): RecordingSegment[] {
  const channels = listChannelIds(channelId)
  const ffmpegPath = resolveFfmpegPath()
  const out: RecordingSegment[] = []

  for (const id of channels) {
    const index = loadSegmentIndex(id)
    const alive = new Set<string>()
    let dirty = false
    const channelSegs: RecordingSegment[] = []
    const seenNames = new Set<string>()

    for (const dir of segmentSourceDirs(id)) {
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (!isRecordingMediaFile(name)) continue
        if (seenNames.has(name)) continue
        const path = join(dir, name)
        let st
        try {
          st = statSync(path)
        } catch {
          continue
        }
        if (!st.isFile() || st.size < 64) continue
        seenNames.add(name)
        alive.add(name)

        const prev = index.get(name)
        const lower = name.toLowerCase()
        const isMp4 = lower.endsWith('.mp4')
        const isTs = lower.endsWith('.ts')
        // First sight of a finished segment: normalize container timestamps.
        // Skip files still being written (active FFmpeg segment).
        if (!prev && !isSegmentWriting({ mtimeMs: st.mtimeMs })) {
          if (isMp4) finalizeSegmentMp4(path, ffmpegPath)
          else if (isTs) finalizeSegmentTs(path, ffmpegPath)
          try {
            st = statSync(path)
          } catch {
            continue
          }
        }

        const { startMs, endMs, entry } = estimateRange(
          name,
          st.mtimeMs,
          st.size,
          segmentTimeSec,
          prev,
          ffmpegPath,
          path,
        )
        if (entry) {
          index.set(name, entry)
          dirty = true
        }

        channelSegs.push({
          id: `${id}/${name}`,
          channelId: id,
          fileName: name,
          path,
          url: media.recordingUrl(id, name),
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          startMs,
          endMs,
          protected: false,
        })
      }
    }

    const trimmed = trimOverlappingSegmentEnds(
      channelSegs.map((s) => ({
        ...s,
        startMs: s.startMs ?? s.mtimeMs,
        endMs: s.endMs ?? s.mtimeMs,
      })),
    )
    for (const s of trimmed) {
      const prev = index.get(s.fileName)
      if (prev && (prev.startMs !== s.startMs || prev.endMs !== s.endMs)) {
        index.set(s.fileName, {
          ...prev,
          startMs: s.startMs,
          endMs: s.endMs,
          durationMs: Math.max(0, s.endMs - s.startMs),
          indexedAt: Date.now(),
        })
        dirty = true
      }
      out.push({
        ...s,
        startMs: s.startMs,
        endMs: s.endMs,
      })
    }

    for (const key of [...index.keys()]) {
      if (!alive.has(key)) {
        index.delete(key)
        dirty = true
      }
    }
    if (dirty) saveSegmentIndex(id, index)
  }

  out.sort((a, b) => (b.startMs ?? b.mtimeMs) - (a.startMs ?? a.mtimeMs))
  return out
}

/** Index a segment after it is finalized (e.g. flushed from write cache). */
export function indexRecordingFile(
  channelId: string,
  fileName: string,
  filePath: string,
  segmentTimeSec = 300,
  opts?: { finalize?: boolean },
): void {
  if (!existsSync(filePath)) return
  const ffmpegPath = resolveFfmpegPath()
  if (opts?.finalize !== false) {
    const lower = fileName.toLowerCase()
    if (lower.endsWith('.mp4')) finalizeSegmentMp4(filePath, ffmpegPath)
    else if (lower.endsWith('.ts')) finalizeSegmentTs(filePath, ffmpegPath)
  }
  let st
  try {
    st = statSync(filePath)
  } catch {
    return
  }
  if (!st.isFile() || st.size < 64) return
  const prev = loadSegmentIndex(channelId).get(fileName)
  const { entry } = estimateRange(
    fileName,
    st.mtimeMs,
    st.size,
    segmentTimeSec,
    prev,
    ffmpegPath,
    filePath,
  )
  if (entry) upsertSegmentIndexEntry(channelId, entry)
}
