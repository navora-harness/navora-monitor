/**
 * Channel-scoped HLS VOD playlist generation for MediaServer / RemoteServer.
 */

import { collectChannelSegments } from './export-clip'
import { channelSavedDir } from './data-root'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSegmentStartMs } from '../../shared/segment-time'
import {
  buildVodM3u8,
  isMpegTsFileName,
  type VodPlaylistResult,
  type VodSeg,
} from '../../shared/vod-playlist'
import { isSegmentWriting } from '../../shared/segment-writing'
import { loadSettings } from './settings-store'

const CACHE_TTL_MS = 4000
const cache = new Map<string, { at: number; result: VodPlaylistResult }>()

export type VodSource = 'loop' | 'saved'

function recentlyWrittenSkip(segments: Array<{ fileName: string; mtimeMs: number }>): Set<string> {
  const skip = new Set<string>()
  const now = Date.now()
  for (const s of segments) {
    if (isSegmentWriting(s, now)) skip.add(s.fileName)
  }
  return skip
}

function collectSavedTsSegments(channelId: string): Array<VodSeg & { mtimeMs: number }> {
  const dir = channelSavedDir(channelId)
  if (!existsSync(dir)) return []
  const segmentTime = (loadSettings().defaultSegmentTimeSec || 300) * 1000
  const out: Array<VodSeg & { mtimeMs: number }> = []
  for (const name of readdirSync(dir)) {
    if (!isMpegTsFileName(name)) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size < 64) continue
      const startMs = parseSegmentStartMs(name) ?? st.mtimeMs - segmentTime
      const endMs = Math.max(startMs + 500, st.mtimeMs)
      out.push({ fileName: name, startMs, endMs, sizeBytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

function collectLoopTsSegments(channelId: string): Array<VodSeg & { mtimeMs: number }> {
  return collectChannelSegments(channelId)
    .filter((s) => isMpegTsFileName(s.fileName))
    .map((s) => ({
      fileName: s.fileName,
      startMs: s.startMs,
      endMs: s.endMs,
      sizeBytes: s.sizeBytes,
      mtimeMs: s.mtimeMs,
    }))
}

/**
 * Build VOD m3u8 for a wall-clock window.
 * @param mediaPrefix e.g. `/recordings/chId` (local) or `/media/recordings/chId` (remote)
 */
export function getChannelVodPlaylist(opts: {
  channelId: string
  startMs: number
  endMs: number
  source?: VodSource
  mediaPrefix: string
}): VodPlaylistResult | null {
  const channelId = opts.channelId?.trim()
  if (!channelId) return null
  const source: VodSource = opts.source === 'saved' ? 'saved' : 'loop'
  const key = `${source}|${channelId}|${opts.startMs}|${opts.endMs}|${opts.mediaPrefix}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result

  const raw = source === 'saved' ? collectSavedTsSegments(channelId) : collectLoopTsSegments(channelId)
  const skip = recentlyWrittenSkip(raw)
  const result = buildVodM3u8(opts.startMs, opts.endMs, {
    channelId,
    mediaPrefix: opts.mediaPrefix,
    segments: raw,
    skipFileNames: skip,
  })
  if (!result) return null
  cache.set(key, { at: Date.now(), result })
  return result
}

export function vodUrlLocal(
  baseUrl: string,
  channelId: string,
  startMs: number,
  endMs: number,
  source: VodSource = 'loop',
): string {
  const q = source === 'saved' ? '?source=saved' : ''
  return `${baseUrl.replace(/\/$/, '')}/vod/${encodeURIComponent(channelId)}/start/${Math.round(startMs)}/end/${Math.round(endMs)}/index.m3u8${q}`
}
