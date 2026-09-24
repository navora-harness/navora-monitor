import { protocol, net } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  channelCacheDir,
  channelRecordDir,
  channelSavedDir,
} from './data-root'

/** Custom scheme for local recording / saved-clip media (desktop renderer). */
export const MEDIA_SCHEME = 'navora'

export function registerMediaSchemePrivileged() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ])
}

/** Decode path segments from a media URL (HTTP or navora). */
export function decodeMediaParts(parts: string[]): string[] {
  return parts.map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
}

export type MediaUrlParts = {
  kind: 'recordings' | 'saved'
  channelId: string
  fileName: string
}

/**
 * Parse recordings/saved path from HTTP or navora:// URLs.
 *
 * Chromium often rewrites `navora:///recordings/ch/file.ts` into
 * `navora://recordings/ch/file.ts` (host = "recordings"). Handle both.
 */
export function parseMediaUrl(requestUrl: string): MediaUrlParts | null {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return null
  }

  const pathParts = decodeMediaParts(u.pathname.split('/').filter(Boolean))
  const host = (u.hostname || '').toLowerCase()
  let parts = pathParts

  // Host is the first path segment when Chromium hoisted it out of the path
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    parts = [host, ...pathParts]
  }

  const kind = parts[0]
  const channelId = parts[1]
  const fileName = parts.slice(2).join('/')
  if ((kind !== 'recordings' && kind !== 'saved') || !channelId || !fileName) {
    return null
  }
  return { kind, channelId, fileName }
}

/**
 * Resolve a recording or saved-clip file on disk.
 * Recordings always also check the write-cache directory (active / orphan .ts).
 */
export function resolveMediaFile(
  kind: 'recordings' | 'saved',
  channelId: string,
  fileName: string,
): string | null {
  if (!channelId || !fileName) return null
  // Reject path traversal in fileName
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return null
  }

  if (kind === 'saved') {
    const p = join(channelSavedDir(channelId), fileName)
    return existsSync(p) && statSync(p).isFile() ? p : null
  }

  const archive = join(channelRecordDir(channelId), fileName)
  if (existsSync(archive) && statSync(archive).isFile()) return archive

  const cached = join(channelCacheDir(channelId), fileName)
  if (existsSync(cached) && statSync(cached).isFile()) return cached

  return null
}

/** Prefer localhost host so Chromium does not steal "recordings" as hostname. */
export function localRecordingUrl(channelId: string, fileName: string): string {
  return `${MEDIA_SCHEME}://localhost/recordings/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
}

export function localSavedClipUrl(channelId: string, fileName: string): string {
  return `${MEDIA_SCHEME}://localhost/saved/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
}

/**
 * Register navora:// handler. Call after app.whenReady().
 * Uses file:// under the hood so Range requests work for mpegts.js seeking.
 */
export function registerMediaProtocolHandler() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const parsed = parseMediaUrl(request.url)
      if (!parsed) {
        console.warn(`[navora] 404 bad url ${request.url}`)
        return new Response('not found', { status: 404 })
      }
      const file = resolveMediaFile(parsed.kind, parsed.channelId, parsed.fileName)
      if (!file) {
        console.warn(
          `[navora] 404 ${parsed.kind}/${parsed.channelId}/${parsed.fileName} (from ${request.url})`,
        )
        return new Response('not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(file).href, {
        headers: request.headers,
        method: request.method,
      })
    } catch (e) {
      console.warn('[navora] protocol error', e)
      return new Response('error', { status: 500 })
    }
  })
}
