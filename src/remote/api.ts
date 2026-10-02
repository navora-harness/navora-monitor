import type { ChannelConfig, ChannelRuntimeState, RecordingSegment } from '@shared/types'
import { REMOTE_USERNAME } from '@shared/password'

const TOKEN_KEY = 'nm_remote_token'

export class AuthError extends Error {
  constructor(message = '未登录') {
    super(message)
    this.name = 'AuthError'
  }
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setStoredToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

async function request<T>(
  path: string,
  opts: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(opts.headers)
  if (opts.json !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  const token = getStoredToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, {
    ...opts,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  })

  if (res.status === 401) {
    setStoredToken(null)
    throw new AuthError()
  }

  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`请求失败 (${res.status})`)
    return undefined as T
  }
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : `请求失败 (${res.status})`)
  }
  return data
}

export async function login(username: string, password: string) {
  const data = await request<{ ok: true; token: string; username: string }>('/api/login', {
    method: 'POST',
    json: { username: username.trim() || REMOTE_USERNAME, password },
  })
  setStoredToken(data.token)
  return data
}

export async function logout() {
  try {
    await request('/api/logout', { method: 'POST', json: {} })
  } catch {
    /* ignore */
  }
  setStoredToken(null)
}

export type RemoteAppMeta = {
  name: string
  version: string
  license: string
  copyright: string
  homepage: string
  licenseNote: string
}

export type RemoteBootstrap = {
  channels: ChannelConfig[]
  groupOrder: string[]
  states: ChannelRuntimeState[]
  uiTheme: 'light' | 'dark' | 'system'
  app?: RemoteAppMeta
}

export function fetchBootstrap() {
  return request<RemoteBootstrap>('/api/bootstrap')
}

export function fetchRemoteStatus() {
  return request<
    { ok: true; username: string; listening: boolean } & Partial<RemoteAppMeta>
  >('/api/status')
}

export function fetchStates() {
  return request<{ states: ChannelRuntimeState[] }>('/api/states')
}

export function syncPreviews(channelIds: string[], hevcMse?: boolean) {
  return request<{ ok: true; states: ChannelRuntimeState[] }>('/api/previews', {
    method: 'POST',
    json: { channelIds, hevcMse },
  })
}

export function reportClientCaps(caps: { hevcMse: boolean }) {
  return request<{ ok: true; previewTranscodeH264?: boolean }>('/api/client-caps', {
    method: 'POST',
    json: caps,
  })
}

export function fetchRecordings(channelId?: string | null) {
  const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''
  return request<{ segments: RecordingSegment[] }>(`/api/recordings${q}`)
}

export function fetchSavedClips(channelId?: string | null) {
  const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''
  return request<{ segments: RecordingSegment[] }>(`/api/saved-clips${q}`)
}

/**
 * Prefer {@link buildRemoteLivePreviewUrl} for live cells — host previewUrl is
 * often 127.0.0.1 and never fetched by the remote browser.
 */
export { buildRemoteLivePreviewUrl as remoteLivePreviewUrl } from '../media-url'

/**
 * Normalize host media URLs for the remote browser:
 * - Force absolute URL on current origin (mpegts.js often skips relative/127.0.0.1)
 * - Map /preview and /recordings onto /media/* auth proxy
 * - Attach session token
 */
export function withMediaAuth(url: string | null | undefined): string | null {
  if (!url) return null
  const token = getStoredToken()
  const origin =
    typeof location !== 'undefined' && location.origin ? location.origin : 'http://local'
  try {
    const u = new URL(url, origin)
    let path = u.pathname
    if (path.startsWith('/preview/')) path = `/media${path}`
    else if (path.startsWith('/recordings/') || path.startsWith('/saved/')) path = `/media${path}`

    const out = new URL(path, origin)
    for (const [k, v] of u.searchParams) {
      if (k === 'token') continue
      out.searchParams.set(k, v)
    }
    if (token) out.searchParams.set('token', token)
    // Always absolute — relative paths caused "连接中" with zero network requests.
    return out.href
  } catch {
    if (!token) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }
}

export function withSegmentMediaAuth(seg: RecordingSegment): RecordingSegment {
  return { ...seg, url: withMediaAuth(seg.url) ?? seg.url }
}
