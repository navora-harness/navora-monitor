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

export function syncPreviews(channelIds: string[]) {
  return request<{ ok: true; states: ChannelRuntimeState[] }>('/api/previews', {
    method: 'POST',
    json: { channelIds },
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

/** Attach auth token so mpegts.js / video media requests pass remote auth. */
export function withMediaAuth(url: string | null | undefined): string | null {
  if (!url) return null
  const token = getStoredToken()
  if (!token) return url
  try {
    const u = new URL(url, typeof location !== 'undefined' ? location.origin : 'http://local')
    u.searchParams.set('token', token)
    return u.pathname + u.search
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }
}

export function withSegmentMediaAuth(seg: RecordingSegment): RecordingSegment {
  return { ...seg, url: withMediaAuth(seg.url) ?? seg.url }
}
