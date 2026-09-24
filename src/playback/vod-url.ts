/**
 * Build HLS VOD playlist URL from a sample media URL (local or remote).
 */

export type VodSource = 'loop' | 'saved'

export function buildVodPlaylistUrl(opts: {
  channelId: string
  startMs: number
  endMs: number
  source?: VodSource
  /** Any recording/saved URL from the same host (used to detect remote /media prefix). */
  sampleMediaUrl?: string | null
}): string | null {
  const channelId = opts.channelId?.trim()
  if (!channelId) return null
  const source = opts.source === 'saved' ? 'saved' : 'loop'
  const q = source === 'saved' ? '?source=saved' : ''
  const start = Math.round(opts.startMs)
  const end = Math.round(opts.endMs)
  const sample = opts.sampleMediaUrl ?? ''

  try {
    if (sample.includes('/media/recordings/') || sample.includes('/media/saved/')) {
      const u = new URL(sample, typeof location !== 'undefined' ? location.origin : 'http://local')
      return `${u.origin}/media/vod/${encodeURIComponent(channelId)}/start/${start}/end/${end}/index.m3u8${q}`
    }
    if (sample.startsWith('http://') || sample.startsWith('https://')) {
      const u = new URL(sample)
      return `${u.origin}/vod/${encodeURIComponent(channelId)}/start/${start}/end/${end}/index.m3u8${q}`
    }
    if (sample.startsWith('/media/')) {
      const origin = typeof location !== 'undefined' ? location.origin : ''
      return `${origin}/media/vod/${encodeURIComponent(channelId)}/start/${start}/end/${end}/index.m3u8${q}`
    }
  } catch {
    /* fall through */
  }

  // Relative desktop path without absolute sample
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    const remote = sample.includes('/media/') || location.pathname.includes('remote')
    if (remote || sample.startsWith('/media')) {
      return `/media/vod/${encodeURIComponent(channelId)}/start/${start}/end/${end}/index.m3u8${q}`
    }
  }
  return null
}

/** Append ?token= for remote when cookie may not cover XHR (hls.js). */
export function withVodAuth(url: string, token: string | null | undefined): string {
  if (!url || !token) return url
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : 'http://local')
    u.searchParams.set('token', token)
    if (url.startsWith('http')) return u.toString()
    return u.pathname + u.search
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }
}
