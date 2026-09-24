import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import {
  concatSeekAndDuration,
  formatExportStamp,
  segmentsOverlappingRange,
  type TimedSegment,
} from '../../shared/export-clip'
import { isRecordingMediaFile, parseSegmentStartMs } from '../../shared/segment-time'
import {
  channelCacheDir,
  channelRecordDir,
  channelSavedDir,
  isRecordCacheActive,
} from './data-root'
import { probeFfmpeg, resolveFfmpegPath } from './ffmpeg/resolve'
import { loadSegmentIndex } from './segment-index-store'
import { loadSettings } from './settings-store'

const execFileAsync = promisify(execFile)

export type ExportClipRangeResult =
  | {
      ok: true
      path: string
      fileName: string
      channelId: string
      startMs: number
      endMs: number
      segmentCount: number
      message: string
    }
  | { ok: false; error: string; canceled?: true }

type DiskSeg = TimedSegment & { sizeBytes: number; mtimeMs: number }

function listMediaInDir(dir: string): Array<{ path: string; fileName: string; sizeBytes: number; mtimeMs: number }> {
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; fileName: string; sizeBytes: number; mtimeMs: number }> = []
  for (const name of readdirSync(dir)) {
    if (!isRecordingMediaFile(name)) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size < 64) continue
      out.push({ path, fileName: name, sizeBytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return out
}

function sourceDirs(channelId: string): string[] {
  const dirs = [channelRecordDir(channelId)]
  if (isRecordCacheActive()) dirs.push(channelCacheDir(channelId))
  return dirs
}

/** Collect timed segments for a channel from record (+ cache) dirs. */
export function collectChannelSegments(channelId: string): DiskSeg[] {
  const segmentTime = loadSettings().defaultSegmentTimeSec || 300
  const index = loadSegmentIndex(channelId)
  const seen = new Set<string>()
  const out: DiskSeg[] = []

  for (const dir of sourceDirs(channelId)) {
    for (const f of listMediaInDir(dir)) {
      if (seen.has(f.fileName)) continue
      seen.add(f.fileName)
      const cached = index.get(f.fileName)
      let startMs: number
      let endMs: number
      if (cached && cached.sizeBytes === f.sizeBytes && cached.endMs > cached.startMs) {
        startMs = cached.startMs
        endMs = cached.endMs
      } else {
        const parsed = parseSegmentStartMs(f.fileName)
        startMs = parsed ?? f.mtimeMs - segmentTime * 1000
        endMs = parsed != null ? parsed + segmentTime * 1000 : f.mtimeMs
        if (cached && cached.endMs > cached.startMs) {
          startMs = cached.startMs
          endMs = Math.max(endMs, cached.endMs)
        }
      }
      if (endMs <= startMs) endMs = startMs + 1000
      out.push({
        path: f.path,
        fileName: f.fileName,
        startMs,
        endMs,
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
      })
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

function escapeConcatPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''")
}

function writeConcatList(files: string[], listPath: string) {
  const body = ['ffconcat version 1.0', ...files.map((f) => `file '${escapeConcatPath(f)}'`)].join('\n')
  writeFileSync(listPath, body, 'utf8')
}

/**
 * Merge overlapping loop segments into one MP4 under SavedClips (protected).
 * Trims to [startMs, endMs] via concat demuxer + seek/duration.
 */
export async function exportClipRange(opts: {
  channelId: string
  startMs: number
  endMs: number
  /** Absolute output path; default SavedClips/<id>/Export_….mp4 */
  outputPath?: string
}): Promise<ExportClipRangeResult> {
  const channelId = opts.channelId?.trim()
  if (!channelId) return { ok: false, error: '未指定通道' }

  const startMs = Math.min(opts.startMs, opts.endMs)
  const endMs = Math.max(opts.startMs, opts.endMs)
  if (!(endMs > startMs)) return { ok: false, error: '时间范围无效' }
  if (endMs - startMs < 500) return { ok: false, error: '导出时长至少 0.5 秒' }
  if (endMs - startMs > 6 * 60 * 60 * 1000) {
    return { ok: false, error: '单次导出不超过 6 小时' }
  }

  const ffmpeg = resolveFfmpegPath(loadSettings().ffmpegPath || null)
  if (!ffmpeg || !probeFfmpeg(ffmpeg)) {
    return { ok: false, error: '未找到可用的 FFmpeg' }
  }

  const all = collectChannelSegments(channelId)
  const ordered = segmentsOverlappingRange(all, startMs, endMs)
  if (!ordered.length) {
    return { ok: false, error: '所选时间段内没有录像' }
  }

  const seek = concatSeekAndDuration(ordered, startMs, endMs)
  if (!seek) return { ok: false, error: '无法计算导出范围' }

  const destDir = channelSavedDir(channelId)
  const fileName =
    opts.outputPath != null
      ? basename(opts.outputPath)
      : `Export_${formatExportStamp(startMs)}_${formatExportStamp(endMs)}.mp4`
  const outPath = opts.outputPath ?? join(destDir, fileName)

  const tmpDir = mkdtempSync(join(tmpdir(), 'navora-export-'))
  const listPath = join(tmpDir, 'concat.txt')
  writeConcatList(
    ordered.map((s) => s.path),
    listPath,
  )

  try {
    // Input seek on concat stream, then limit duration; remux to MP4 for SavedClips / players.
    await execFileAsync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        seek.seekSec.toFixed(3),
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-t',
        seek.durationSec.toFixed(3),
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        '-avoid_negative_ts',
        'make_zero',
        outPath,
      ],
      { windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Fallback: remux without stream-copy if codecs refuse MP4 copy
    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-ss',
          seek.seekSec.toFixed(3),
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-t',
          seek.durationSec.toFixed(3),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          outPath,
        ],
        { windowsHide: true, timeout: 1_800_000, maxBuffer: 4 * 1024 * 1024 },
      )
    } catch (e2) {
      cleanupDir(tmpDir)
      return {
        ok: false,
        error: e2 instanceof Error ? e2.message : msg || 'FFmpeg 导出失败',
      }
    }
  }

  cleanupDir(tmpDir)

  if (!existsSync(outPath)) {
    return { ok: false, error: '导出文件未生成' }
  }

  let size = 0
  try {
    size = statSync(outPath).size
  } catch {
    /* ignore */
  }
  if (size < 64) {
    try {
      unlinkSync(outPath)
    } catch {
      /* ignore */
    }
    return { ok: false, error: '导出文件过小，可能合并失败' }
  }

  const mins = Math.max(1, Math.round((endMs - startMs) / 60_000))
  return {
    ok: true,
    path: outPath,
    fileName: basename(outPath),
    channelId,
    startMs,
    endMs,
    segmentCount: ordered.length,
    message: `已导出合并片段（${ordered.length} 段 → 约 ${mins} 分钟），已存入受保护目录`,
  }
}

function cleanupDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
