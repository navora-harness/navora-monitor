import { execFile } from 'node:child_process'
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { probeFfmpeg, resolveFfmpegPath } from './resolve'
import { loadSettings } from '../settings-store'

const execFileAsync = promisify(execFile)

export type RemuxPlaybackResult =
  | { ok: true; path: string; cached: boolean; fileName: string }
  | { ok: false; error: string }

/** Deduplicate concurrent remux of the same source path. */
const inflight = new Map<string, Promise<RemuxPlaybackResult>>()
/** Cap parallel remux jobs so scrubbing cannot starve live-preview FFmpeg. */
const MAX_PARALLEL_REMUX = 1
let remuxActive = 0
const remuxWait: Array<() => void> = []

async function withRemuxSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (remuxActive >= MAX_PARALLEL_REMUX) {
    await new Promise<void>((resolve) => remuxWait.push(resolve))
  }
  remuxActive += 1
  try {
    return await fn()
  } finally {
    remuxActive -= 1
    remuxWait.shift()?.()
  }
}

/** Sidecar cache next to the .ts: `foo.ts.play.mp4` (+ `.meta`). */
export function playbackCachePaths(srcPath: string): { outPath: string; metaPath: string; fileName: string } {
  const fileName = `${basename(srcPath)}.play.mp4`
  const outPath = join(dirname(srcPath), fileName)
  return { outPath, metaPath: `${outPath}.meta`, fileName }
}

function ffmpegErrMessage(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e)
  const err = e as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer }
  const stderr = (typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString?.())?.trim()
  if (stderr) return stderr.slice(0, 400)
  const msg = typeof err.message === 'string' ? err.message : String(e)
  // Drop the long echoed argv; keep a short reason
  const line = msg.split('\n').find((l) => /error|invalid|failed|unknown/i.test(l)) ?? msg
  return line.replace(/^Command failed:\s*/i, '').slice(0, 400)
}

/**
 * Remux MPEG-TS → MP4 (stream copy) for reliable HTML5 &lt;video&gt; playback.
 *
 * Why (public docs / issues):
 * - mpegts.js: HEVC over MSE is mainly reliable on Safari
 * - Chromium MSE often shows one frame then freezes while audio clock advances
 *   (CCTV PCR timelines, Open-GOP / mid-GOP segment cuts with -c copy)
 * Native MP4 demux avoids the mpegts.js → fMP4 → MSE path for VOD.
 */
export async function remuxTsForPlayback(srcPath: string): Promise<RemuxPlaybackResult> {
  const key = srcPath
  const existing = inflight.get(key)
  if (existing) return existing

  const job = withRemuxSlot(() => remuxTsForPlaybackOnce(srcPath)).finally(() => {
    if (inflight.get(key) === job) inflight.delete(key)
  })
  inflight.set(key, job)
  return job
}

async function remuxTsForPlaybackOnce(srcPath: string): Promise<RemuxPlaybackResult> {
  if (!srcPath || !existsSync(srcPath)) {
    return { ok: false, error: '源文件不存在' }
  }
  const st = statSync(srcPath)
  if (!st.isFile() || st.size < 64) {
    return { ok: false, error: '源文件无效' }
  }

  const ffmpeg = resolveFfmpegPath(loadSettings().ffmpegPath || null)
  if (!ffmpeg || !probeFfmpeg(ffmpeg)) {
    return { ok: false, error: '未找到可用的 FFmpeg' }
  }

  const { outPath, metaPath, fileName } = playbackCachePaths(srcPath)

  if (existsSync(outPath) && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { size?: number; mtimeMs?: number }
      if (meta.size === st.size && Math.abs((meta.mtimeMs ?? 0) - st.mtimeMs) < 1.5) {
        return { ok: true, path: outPath, cached: true, fileName }
      }
    } catch {
      /* remux again */
    }
  }

  const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp.mp4`

  const cleanTmp = () => {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  cleanTmp()

  /**
   * Strategies (copy only — no re-encode):
   * 1. video+audio, hvc1 tag (best for Chromium HEVC)
   * 2. video+audio, default tags
   * 3. video-only (some cameras ship broken / exotic audio)
   *
   * Avoid `-map 0`: CCTV TS often has data/private PIDs that MP4 cannot hold.
   */
  const attempts: string[][] = [
    ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-tag:v', 'hvc1'],
    ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy'],
    ['-map', '0:v:0', '-c', 'copy', '-tag:v', 'hvc1'],
    ['-map', '0:v:0', '-c', 'copy'],
  ]

  let lastErr = 'FFmpeg 转封装失败'
  let ok = false
  for (const mid of attempts) {
    cleanTmp()
    try {
      await execFileAsync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-fflags',
          '+genpts+igndts',
          '-i',
          srcPath,
          ...mid,
          '-movflags',
          '+faststart',
          '-avoid_negative_ts',
          'make_zero',
          tmp,
        ],
        { windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      )
      if (existsSync(tmp) && statSync(tmp).size >= 64) {
        ok = true
        break
      }
      lastErr = '转封装产物过小'
    } catch (e) {
      lastErr = ffmpegErrMessage(e) || lastErr
    }
  }

  if (!ok) {
    cleanTmp()
    return { ok: false, error: lastErr }
  }

  try {
    if (existsSync(outPath)) unlinkSync(outPath)
  } catch {
    /* ignore */
  }
  try {
    renameSync(tmp, outPath)
  } catch (e) {
    cleanTmp()
    return { ok: false, error: e instanceof Error ? e.message : '写入缓存失败' }
  }

  try {
    writeFileSync(
      metaPath,
      JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, at: Date.now() }),
      'utf8',
    )
  } catch {
    /* cache still usable without meta */
  }

  return { ok: true, path: outPath, cached: false, fileName }
}
