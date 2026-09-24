import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileAsync = promisify(execFile)

const CACHE_DIR = join(tmpdir(), 'navora-remux-play')
const META_SUFFIX = '.meta.json'
const TTL_MS = 2 * 60 * 60 * 1000
const inflight = new Map<string, Promise<string>>()

type CacheMeta = {
  srcPath: string
  srcSize: number
  srcMtimeMs: number
  startSec: number
  at: number
}

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
}

function cacheKey(srcPath: string, srcSize: number, srcMtimeMs: number, startSec: number): string {
  const raw = `${srcPath}|${srcSize}|${srcMtimeMs}|${startSec.toFixed(2)}`
  return createHash('sha1').update(raw).digest('hex')
}

function cachePaths(key: string): { mp4: string; meta: string } {
  return {
    mp4: join(CACHE_DIR, `${key}.mp4`),
    meta: join(CACHE_DIR, `${key}${META_SUFFIX}`),
  }
}

function ffmpegErr(e: unknown): string {
  if (!e || typeof e !== 'object') return String(e)
  const err = e as { stderr?: string | Buffer; message?: string }
  const stderr = (typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString?.())?.trim()
  if (stderr) {
    const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const interesting = lines.filter((l) => !/^frame=/i.test(l))
    return (interesting.at(-1) || interesting.join(' | ') || stderr).slice(0, 400)
  }
  return (err.message || String(e)).slice(0, 400)
}

/** Drop temp remux files older than TTL. */
export function pruneRemuxPlayCache(now = Date.now()) {
  try {
    ensureCacheDir()
    for (const name of readdirSync(CACHE_DIR)) {
      if (!name.endsWith('.mp4') && !name.endsWith(META_SUFFIX)) continue
      const p = join(CACHE_DIR, name)
      try {
        const st = statSync(p)
        if (now - st.mtimeMs > TTL_MS) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Build a list of copy-remux argv variants.
 * CCTV TS is often video-only HEVC; optional audio maps / hvc1 tags vary by FFmpeg build.
 */
export function buildRemuxAttemptArgs(opts: {
  inputPath: string
  outputPath: string
  startSec: number
  /** Put -ss after -i (slower, more accurate near EOF). */
  ssAfterInput?: boolean
  includeAudio?: boolean
  tagHvc1?: boolean
}): string[] {
  const start = Math.max(0, opts.startSec)
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+genpts+igndts+discardcorrupt',
    '-probesize',
    '5000000',
    '-analyzeduration',
    '5000000',
  ]

  if (start > 0.05 && !opts.ssAfterInput) {
    args.push('-ss', start.toFixed(3))
  }

  args.push('-i', opts.inputPath)

  if (start > 0.05 && opts.ssAfterInput) {
    args.push('-ss', start.toFixed(3))
  }

  // Never -map 0 (private CCTV PIDs break MP4). Video first — many cams have no audio.
  args.push('-map', '0:v:0')
  if (opts.includeAudio) {
    args.push('-map', '0:a:0')
  }

  args.push('-c', 'copy')
  if (opts.tagHvc1 !== false) {
    args.push('-tag:v', 'hvc1')
  }
  if (opts.includeAudio) {
    // ADTS AAC in TS → MP4 needs asc; no-op / ignored if not AAC.
    args.push('-bsf:a', 'aac_adtstoasc')
  }
  args.push(
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    opts.outputPath,
  )
  return args
}

type Attempt = { label: string; args: string[] }

function remuxAttempts(inputPath: string, outputPath: string, startSec: number): Attempt[] {
  const attempts: Attempt[] = []
  const push = (label: string, partial: Omit<Parameters<typeof buildRemuxAttemptArgs>[0], 'inputPath' | 'outputPath'>) => {
    attempts.push({
      label,
      args: buildRemuxAttemptArgs({ inputPath, outputPath, ...partial }),
    })
  }

  // Primary: video-only (matches user's PMT — HEVC only, no audio PID)
  push('v-only ss-before hvc1', { startSec, includeAudio: false, tagHvc1: true, ssAfterInput: false })
  push('v-only ss-before', { startSec, includeAudio: false, tagHvc1: false, ssAfterInput: false })
  push('v-only ss-after hvc1', { startSec, includeAudio: false, tagHvc1: true, ssAfterInput: true })
  // With audio (some segments)
  push('av ss-before hvc1', { startSec, includeAudio: true, tagHvc1: true, ssAfterInput: false })
  push('av ss-before', { startSec, includeAudio: true, tagHvc1: false, ssAfterInput: false })

  if (startSec > 1) {
    // Seek past EOF / bad PCR → empty; last resort play from start of file
    push('v-only from0 hvc1', { startSec: 0, includeAudio: false, tagHvc1: true, ssAfterInput: false })
  }

  return attempts
}

/**
 * Ensure a faststart MP4 exists for [startSec → EOF] of the .ts (stream copy).
 * Stored under OS temp — not beside recordings.
 */
export async function ensureFaststartRemux(opts: {
  ffmpeg: string
  srcPath: string
  startSec: number
}): Promise<{ ok: true; path: string; cached: boolean } | { ok: false; error: string }> {
  if (!opts.srcPath || !existsSync(opts.srcPath)) {
    return { ok: false, error: '源文件不存在' }
  }
  const st = statSync(opts.srcPath)
  if (!st.isFile() || st.size < 64) {
    return { ok: false, error: '源文件无效' }
  }

  const start = Math.max(0, opts.startSec)
  const key = cacheKey(opts.srcPath, st.size, st.mtimeMs, start)
  const { mp4, meta } = cachePaths(key)

  if (existsSync(mp4) && existsSync(meta)) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8')) as CacheMeta
      if (
        m.srcPath === opts.srcPath &&
        m.srcSize === st.size &&
        Math.abs(m.srcMtimeMs - st.mtimeMs) < 1.5 &&
        Math.abs(m.startSec - start) < 0.05 &&
        statSync(mp4).size > 64
      ) {
        return { ok: true, path: mp4, cached: true }
      }
    } catch {
      /* remux again */
    }
  }

  const existing = inflight.get(key)
  if (existing) {
    try {
      const path = await existing
      return { ok: true, path, cached: true }
    } catch (e) {
      return { ok: false, error: ffmpegErr(e) }
    }
  }

  const job = (async () => {
    ensureCacheDir()
    pruneRemuxPlayCache()
    // Must end with .mp4 so muxer guesses correctly even if -f is dropped
    const tmp = `${mp4}.${process.pid}.${Date.now()}.part.mp4`
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }

    const attempts = remuxAttempts(opts.srcPath, tmp, start)
    let lastErr = 'FFmpeg 转封装失败'

    for (const attempt of attempts) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      try {
        await execFileAsync(opts.ffmpeg, attempt.args, {
          windowsHide: true,
          timeout: 600_000,
          maxBuffer: 4 * 1024 * 1024,
        })
        if (existsSync(tmp) && statSync(tmp).size >= 1024) {
          console.info(`[remux-play] ok via ${attempt.label} size=${statSync(tmp).size}`)
          lastErr = ''
          break
        }
        lastErr = `产物过小 (${attempt.label})`
      } catch (e) {
        lastErr = `${attempt.label}: ${ffmpegErr(e)}`
        console.warn('[remux-play] attempt failed', lastErr)
      }
    }

    if (lastErr || !existsSync(tmp) || statSync(tmp).size < 1024) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw new Error(lastErr || '转封装产物过小')
    }

    try {
      if (existsSync(mp4)) unlinkSync(mp4)
    } catch {
      /* ignore */
    }
    renameSync(tmp, mp4)
    try {
      writeFileSync(
        meta,
        JSON.stringify({
          srcPath: opts.srcPath,
          srcSize: st.size,
          srcMtimeMs: st.mtimeMs,
          startSec: start,
          at: Date.now(),
        } satisfies CacheMeta),
        'utf8',
      )
    } catch {
      /* ok without meta */
    }
    return mp4
  })()

  inflight.set(key, job)
  try {
    const path = await job
    return { ok: true, path, cached: false }
  } catch (e) {
    return { ok: false, error: ffmpegErr(e) || 'FFmpeg 转封装失败' }
  } finally {
    if (inflight.get(key) === job) inflight.delete(key)
  }
}

/**
 * Remux then Range-serve a temp faststart MP4 for native &lt;video&gt;.
 */
export async function serveTsRemuxAsMp4(opts: {
  ffmpeg: string
  srcPath: string
  startSec: number
  req: IncomingMessage
  res: ServerResponse
  sendFile: (
    file: string,
    req: IncomingMessage,
    res: ServerResponse,
    opts?: { noCache?: boolean },
  ) => void
}): Promise<void> {
  console.info(
    `[remux-play] request start=${opts.startSec.toFixed(3)} src=${opts.srcPath}`,
  )
  const prepared = await ensureFaststartRemux({
    ffmpeg: opts.ffmpeg,
    srcPath: opts.srcPath,
    startSec: opts.startSec,
  })
  if (!prepared.ok) {
    if (!opts.res.headersSent) {
      opts.res.writeHead(502, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      opts.res.end(prepared.error || 'remux failed')
    }
    console.warn('[remux-play] 502', prepared.error)
    return
  }
  console.info(`[remux-play] serve cached=${prepared.cached} ${prepared.path}`)
  if (opts.req.method === 'HEAD') {
    const st = statSync(prepared.path)
    opts.res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    opts.res.end()
    return
  }
  opts.sendFile(prepared.path, opts.req, opts.res, { noCache: true })
}
