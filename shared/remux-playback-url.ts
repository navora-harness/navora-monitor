/**
 * Build localhost HTTP URL for FFmpeg fMP4 remux playback of a .ts segment.
 * Desktop only (http://127.0.0.1) — custom schemes cannot host a live pipe.
 */

/** Rewrite `/recordings|saved/.../file.ts` → `/remux/.../file.ts?t=`. */
export function toRemuxPlaybackUrl(mediaUrl: string, startSec = 0): string | null {
  let u: URL
  try {
    u = new URL(mediaUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const parts = u.pathname
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })

  const kind = parts[0]
  const channelId = parts[1]
  const fileName = parts.slice(2).join('/')
  if ((kind !== 'recordings' && kind !== 'saved') || !channelId || !fileName) return null
  if (!fileName.toLowerCase().endsWith('.ts')) return null

  const out = new URL(u.origin)
  out.pathname = `/remux/${kind}/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
  out.searchParams.set('t', Math.max(0, startSec).toFixed(3))
  // Bust Chromium media cache when scrubbing (same path, new FFmpeg session).
  out.searchParams.set('_', String(Date.now()))
  return out.toString()
}

/** Update `t=` on an existing remux URL (scrub → kill/restart stream). */
export function withRemuxStartSec(remuxUrl: string, startSec: number): string {
  try {
    const u = new URL(remuxUrl)
    u.searchParams.set('t', Math.max(0, startSec).toFixed(3))
    u.searchParams.set('_', String(Date.now()))
    return u.toString()
  } catch {
    return remuxUrl
  }
}
