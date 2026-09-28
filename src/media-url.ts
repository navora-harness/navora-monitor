const TOKEN_KEY = 'nm_remote_token'

function readRemoteToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/**
 * Absolute live MPEG-TS URL for remote browser playback.
 * Built from channel id + current origin + session token — never from host
 * `http://127.0.0.1/.../preview/...` (mpegts.js will not fetch that from LAN).
 */
export function buildRemoteLivePreviewUrl(channelId: string): string | null {
  if (!channelId) return null
  const origin =
    typeof location !== 'undefined' && location.origin ? location.origin : ''
  if (!origin) return null
  const out = new URL(
    `/media/preview/${encodeURIComponent(channelId)}/live.ts`,
    origin,
  )
  const token = readRemoteToken()
  if (token) out.searchParams.set('token', token)
  return out.href
}
