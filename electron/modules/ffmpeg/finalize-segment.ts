import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, unlinkSync } from 'node:fs'
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
