import { dirname, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isSegmentWriting } from '../../shared/segment-writing'
import {
  channelCacheDir,
  channelRecordDir,
  channelSavedDir,
  recordCacheRoot,
  recordingsRoot,
  savedClipsRoot,
} from './data-root'
import { finalizeSegmentTs } from './ffmpeg/finalize-segment'
import { resolveFfmpegPath } from './ffmpeg/resolve'
import { loadChannels } from './channel-store'

export type RepairRecordingsResult = {
  ok: true
  scanned: number
  needed: number
  repaired: number
  skipped: number
  failed: number
  message: string
}

const SKEW_SEC = 1.5
/** Video start alone this large (no usable audio) still warrants rebase. */
const VIDEO_ORPHAN_START_SEC = 60

let repairInFlight = false

function resolveFfprobe(ffmpegPath: string | null): string | null {
  if (!ffmpegPath) return null
  const dir = dirname(ffmpegPath)
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const beside = join(dir, name)
  return existsSync(beside) ? beside : null
}

function firstPts(probeBin: string, filePath: string, stream: 'v:0' | 'a:0'): number | null {
  try {
    const out = execFileSync(
      probeBin,
      [
        '-v',
        'error',
        '-select_streams',
        stream,
        '-read_intervals',
        '%+#1',
        '-show_entries',
        'packet=pts_time',
        '-of',
        'csv=p=0',
        filePath,
      ],
      { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
    )
    const line = String(out).trim().split(/\r?\n/)[0]?.replace(/,$/, '') ?? ''
    const n = Number(line)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** True when A/V origins look split (camera PCR vs reset audio). */
export function tsNeedsTimestampRepair(filePath: string, probeBin: string | null): boolean {
  if (!probeBin) return true
  const v = firstPts(probeBin, filePath, 'v:0')
  if (v == null) return false
  const a = firstPts(probeBin, filePath, 'a:0')
  if (a == null) return v >= VIDEO_ORPHAN_START_SEC
  return Math.abs(v - a) >= SKEW_SEC
}

function listTsInDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.ts'))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

function listChannelIdsFromRoot(root: string): string[] {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

function collectTsPaths(channelId?: string): string[] {
  const ids = new Set<string>()
  if (channelId?.trim()) {
    ids.add(channelId.trim())
  } else {
    for (const c of loadChannels()) ids.add(c.id)
    for (const id of listChannelIdsFromRoot(recordingsRoot())) ids.add(id)
    for (const id of listChannelIdsFromRoot(recordCacheRoot())) ids.add(id)
    for (const id of listChannelIdsFromRoot(savedClipsRoot())) ids.add(id)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    for (const p of [
      ...listTsInDir(channelRecordDir(id)),
      ...listTsInDir(channelCacheDir(id)),
      ...listTsInDir(channelSavedDir(id)),
    ]) {
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

/**
 * Scan finished .ts recordings / saved clips and normalize split A/V timelines.
 * Stream-copy only — no re-encode. Skips files still being written.
 */
export function repairRecordingTimestamps(opts?: {
  channelId?: string
  /** When true, remux every finished .ts even if probe looks OK. */
  force?: boolean
}): RepairRecordingsResult {
  if (repairInFlight) {
    return {
      ok: true,
      scanned: 0,
      needed: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
      message: '已有修复任务在进行中，请稍候',
    }
  }
  repairInFlight = true
  try {
    const ffmpegPath = resolveFfmpegPath()
    if (!ffmpegPath) {
      return {
        ok: true,
        scanned: 0,
        needed: 0,
        repaired: 0,
        skipped: 0,
        failed: 0,
        message: '未找到 FFmpeg，无法修复',
      }
    }
    const probeBin = resolveFfprobe(ffmpegPath)
    const files = collectTsPaths(opts?.channelId)
    let scanned = 0
    let needed = 0
    let repaired = 0
    let skipped = 0
    let failed = 0

    for (const path of files) {
      let st
      try {
        st = statSync(path)
      } catch {
        failed += 1
        continue
      }
      if (!st.isFile() || st.size < 64) {
        skipped += 1
        continue
      }
      scanned += 1
      if (isSegmentWriting({ mtimeMs: st.mtimeMs })) {
        skipped += 1
        continue
      }

      const needs = opts?.force === true || tsNeedsTimestampRepair(path, probeBin)
      if (!needs) {
        skipped += 1
        continue
      }
      needed += 1
      if (finalizeSegmentTs(path, ffmpegPath)) repaired += 1
      else failed += 1
    }

    const message =
      scanned === 0
        ? '未找到可扫描的 .ts 录像'
        : `扫描 ${scanned} 个 · 需修复 ${needed} · 已修复 ${repaired}` +
          (skipped ? ` · 跳过 ${skipped}` : '') +
          (failed ? ` · 失败 ${failed}` : '')

    return { ok: true, scanned, needed, repaired, skipped, failed, message }
  } finally {
    repairInFlight = false
  }
}
