import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveFfmpegPath } from './resolve'

function resolveFfprobePath(ffmpegPath: string | null): string | null {
  if (!ffmpegPath) return null
  const dir = dirname(ffmpegPath)
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const beside = join(dir, name)
  if (existsSync(beside)) return beside
  // Some bundles only ship ffmpeg — that's fine
  return null
}

function parseHmsDuration(raw: string): number | null {
  const m = /(?:^|\s)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(raw)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3])
  if (![h, mi, s].every((n) => Number.isFinite(n))) return null
  const ms = Math.round((h * 3600 + mi * 60 + s) * 1000)
  return ms > 0 ? ms : null
}

function parseSeconds(raw: string | number | null | undefined): number | null {
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || n <= 0) return null
  const ms = Math.round(n * 1000)
  return ms > 0 ? ms : null
}

type ProbeJson = {
  format?: {
    duration?: string
    size?: string
    bit_rate?: string
  }
  streams?: Array<{
    codec_type?: string
    duration?: string
    start_time?: string
  }>
}

function durationFromFfprobeJson(data: ProbeJson): number | null {
  const formatDur = parseSeconds(data.format?.duration)
  if (formatDur) return formatDur

  let best: number | null = null
  for (const s of data.streams ?? []) {
    const d = parseSeconds(s.duration)
    if (d != null && (best == null || d > best)) best = d
  }
  if (best) return best

  // MPEG-TS often has no duration field — estimate from size / bit_rate
  const size = Number(data.format?.size)
  const bitRate = Number(data.format?.bit_rate)
  if (Number.isFinite(size) && size > 0 && Number.isFinite(bitRate) && bitRate > 1000) {
    const sec = size / (bitRate / 8)
    if (Number.isFinite(sec) && sec > 0.5 && sec < 48 * 3600) {
      return Math.round(sec * 1000)
    }
  }
  return null
}

function probeWithFfprobe(ffprobePath: string, filePath: string): number | null {
  try {
    const out = execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,size,bit_rate:stream=duration,codec_type,start_time',
        '-of',
        'json',
        filePath,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      },
    )
    const data = JSON.parse(out) as ProbeJson
    return durationFromFfprobeJson(data)
  } catch {
    return null
  }
}

function probeWithFfmpegBanner(ffmpegPath: string, filePath: string): number | null {
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 15_000,
    })
    return null
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '')
        : String(err)
    // Prefer the container Duration: line (first match is usually format)
    const m = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/i.exec(stderr)
    if (m) return parseHmsDuration(m[1]!)
    // bitrate + size sometimes appear even when Duration is N/A
    const br = /bitrate:\s*(\d+)\s*kb\/s/i.exec(stderr)
    // no reliable size in banner alone
    void br
    return null
  }
}

/**
 * Read media duration from the file via ffprobe (preferred) or ffmpeg -i.
 * Returns null when the container has no usable duration (common for live-cut MPEG-TS).
 */
export function probeDurationMs(filePath: string, ffmpegPath?: string | null): number | null {
  if (!filePath || !existsSync(filePath)) return null
  const ffmpeg = ffmpegPath || resolveFfmpegPath()
  if (!ffmpeg) return null

  const ffprobe = resolveFfprobePath(ffmpeg)
  if (ffprobe) {
    const fromProbe = probeWithFfprobe(ffprobe, filePath)
    if (fromProbe != null) return fromProbe
  }

  return probeWithFfmpegBanner(ffmpeg, filePath)
}
