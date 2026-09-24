import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { buildNormalizeTsRemuxArgs } from '../../../shared/ffmpeg-args'
import { resolveFfmpegPath } from './resolve'

/**
 * Rewrite moov atom to the front so HTML5 &lt;video&gt; can seek / start quickly.
 * No-op when ffmpeg missing or remux fails (original file kept).
 */
export function finalizeSegmentMp4(filePath: string, ffmpegPath?: string | null): boolean {
  if (!filePath || !existsSync(filePath)) return false
  const bin = ffmpegPath || resolveFfmpegPath()
  if (!bin) return false
  const tmp = `${filePath}.faststart.mp4`
  try {
    execFileSync(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmp],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 },
    )
    if (!existsSync(tmp)) return false
    try {
      unlinkSync(filePath)
    } catch {
      /* Windows may need replace via rename only */
    }
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return false
  }
}

/**
 * Rebase MPEG-TS A/V timestamps to a shared origin (stream copy, no re-encode).
 * Call only on finished segments — never on the file FFmpeg is still writing.
 */
export function finalizeSegmentTs(filePath: string, ffmpegPath?: string | null): boolean {
  if (!filePath || !filePath.toLowerCase().endsWith('.ts')) return false
  if (!existsSync(filePath)) return false
  const bin = ffmpegPath || resolveFfmpegPath()
  if (!bin) return false

  let before = 0
  try {
    before = statSync(filePath).size
  } catch {
    return false
  }
  if (before < 64) return false

  const tmp = `${filePath}.norm.ts`
  const run = (includeAudio: boolean) => {
    execFileSync(bin, buildNormalizeTsRemuxArgs({ inputPath: filePath, outputPath: tmp, includeAudio }), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 180_000,
    })
  }

  try {
    try {
      run(true)
    } catch {
      // Some cameras have no audio PID — retry video-only.
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      run(false)
    }
    if (!existsSync(tmp)) return false
    const after = statSync(tmp).size
    // Guard against empty / truncated remux.
    if (after < 64 || after < before * 0.5) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      return false
    }
    try {
      unlinkSync(filePath)
    } catch {
      /* Windows may need replace via rename only */
    }
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    return false
  }
}
