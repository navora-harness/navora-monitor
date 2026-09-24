/**
 * Prefer localhost HTTP media URLs — custom schemes (navora://) are hostile to Range.
 */

/** Extract http(s) origin from a media URL hint, if any. */
export function httpMediaOrigin(hintUrl: string | null | undefined): string | null {
  if (!hintUrl) return null
  try {
    const u = new URL(hintUrl)
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Rewrite navora://…/recordings|saved/… to http://127.0.0.1:port/…
 * Leaves http(s) URLs unchanged. If rewrite is impossible, returns the input.
 */
export function forceHttpMediaUrl(
  url: string,
  httpOriginHint?: string | null,
): string {
  if (!url) return url
  if (/^https?:\/\//i.test(url)) return url
  if (!/^navora:/i.test(url)) return url

  const origin = httpMediaOrigin(httpOriginHint)
  if (!origin) {
    console.warn('[media] cannot rewrite navora:// without HTTP origin hint:', url)
    return url
  }

  let parts: string[] = []
  try {
    const u = new URL(url)
    const pathParts = u.pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p)
      } catch {
        return p
      }
    })
    const host = (u.hostname || '').toLowerCase()
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      parts = [host, ...pathParts]
    } else {
      parts = pathParts
    }
  } catch {
    return url
  }

  const kind = parts[0]
  const channelId = parts[1]
  const fileName = parts.slice(2).join('/')
  if ((kind !== 'recordings' && kind !== 'saved') || !channelId || !fileName) {
    return url
  }

  return `${origin}/${kind}/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
}
