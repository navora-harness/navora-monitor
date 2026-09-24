import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChannelConfig, ChannelRuntimeState, RecordingSegment } from '../../shared/types'
import { REMOTE_USERNAME } from '../../shared/password'
import type { MediaServer } from './media-server'
import type { PreviewManager } from './preview-manager'
import { loadSettings } from './settings-store'
import { resolveMediaFile, parseMediaUrl } from './media-protocol'

export type RemoteAccessStatus = {
  enabled: boolean
  listening: boolean
  port: number
  urls: string[]
  username: string
  error: string | null
}

type RemoteDeps = {
  media: MediaServer
  previews: PreviewManager
  loadChannels: () => ChannelConfig[]
  getGroupOrder: () => string[]
  mergeState: (channelId: string) => ChannelRuntimeState
  allStates: () => ChannelRuntimeState[]
  listRecordings: (channelId?: string) => RecordingSegment[]
  listSavedClips: (channelId?: string) => RecordingSegment[]
  getStaticRoot: () => string
  getViteDevUrl: () => string | null
  getAppMeta: () => {
    name: string
    version: string
    license: string
    copyright: string
    homepage: string
    licenseNote: string
  }
}

type Session = {
  token: string
  at: number
  previewIds: string[]
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const VIEWER_IDLE_MS = 20_000
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function safeJoin(root: string, parts: string[]): string | null {
  const target = resolve(root, ...parts)
  const rel = relative(root, target)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || normalize(rel).startsWith('..')) {
    return null
  }
  return target
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(data)
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  try {
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

function lanIpv4Addresses(): string[] {
  const nets = networkInterfaces()
  const out: string[] = []
  for (const list of Object.values(nets)) {
    if (!list) continue
    for (const n of list) {
      if (n.family !== 'IPv4' && (n.family as unknown) !== 4) continue
      if (n.internal) continue
      out.push(n.address)
    }
  }
  return [...new Set(out)]
}

export function listRemoteAccessUrls(port: number): string[] {
  const hosts = ['127.0.0.1', ...lanIpv4Addresses()]
  return hosts.map((h) => `http://${h}:${port}/`)
}

function rewritePreviewUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    // http://127.0.0.1:PORT/preview/ID/live.ts → /media/preview/ID/live.ts
    if (u.pathname.includes('/preview/')) {
      return `/media${u.pathname}${u.search}`
    }
  } catch {
    /* ignore */
  }
  return url
}

/** Local media URLs → remote-auth `/media/...` paths (token attached client-side). */
function rewriteMediaFileUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const parsed = parseMediaUrl(url)
  if (parsed) {
    return `/media/${parsed.kind}/${encodeURIComponent(parsed.channelId)}/${encodeURIComponent(parsed.fileName)}`
  }
  try {
    const u = new URL(url)
    if (u.pathname.startsWith('/recordings/') || u.pathname.startsWith('/saved/')) {
      return `/media${u.pathname}`
    }
  } catch {
    /* ignore */
  }
  return url
}

function mapSegmentsForRemote(segments: RecordingSegment[]): RecordingSegment[] {
  return segments.map((s) => ({
    ...s,
    path: '',
    url: rewriteMediaFileUrl(s.url) ?? '',
  }))
}

function mapStatesForRemote(states: ChannelRuntimeState[]): ChannelRuntimeState[] {
  return states.map((s) => ({
    ...s,
    previewUrl: rewritePreviewUrl(s.previewUrl),
  }))
}

export class RemoteServer {
  private server: Server | null = null
  private port = 0
  private error: string | null = null
  private sessions = new Map<string, Session>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private deps: RemoteDeps

  constructor(deps: RemoteDeps) {
    this.deps = deps
  }

  getStatus(): RemoteAccessStatus {
    const s = loadSettings()
    return {
      enabled: s.remoteEnabled,
      listening: !!(this.server && this.port),
      port: this.port || s.remotePort,
      urls: this.port ? listRemoteAccessUrls(this.port) : listRemoteAccessUrls(s.remotePort),
      username: loadSettings().remoteUsername || REMOTE_USERNAME,
      error: this.error,
    }
  }

  async applyFromSettings(): Promise<RemoteAccessStatus> {
    const s = loadSettings()
    if (!s.remoteEnabled) {
      await this.stop()
      return this.getStatus()
    }
    await this.start(s.remotePort)
    return this.getStatus()
  }

  async start(port: number): Promise<void> {
    await this.stop()
    this.error = null
    const listenPort = Math.max(1024, Math.min(65535, Math.round(port) || 8780))

    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : 'error' })
        }
      })
    })

    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `端口 ${listenPort} 已被占用` : err.message
        this.server = null
        this.port = 0
        reject(err)
      })
      this.server!.listen(listenPort, '0.0.0.0', () => {
        this.port = listenPort
        this.error = null
        resolvePromise()
      })
    })

    this.pruneTimer = setInterval(() => this.pruneSessions(), 5_000)
  }

  async stop(): Promise<void> {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.sessions.clear()
    this.syncRemotePreviews([])
    const srv = this.server
    this.server = null
    this.port = 0
    if (!srv) return
    await new Promise<void>((resolvePromise) => {
      srv.close(() => resolvePromise())
    })
  }

  private pruneSessions() {
    const now = Date.now()
    for (const [token, s] of this.sessions) {
      if (now - s.at > TOKEN_TTL_MS) this.sessions.delete(token)
    }
    // Drop idle remote preview demand
    const activeIds = new Set<string>()
    for (const s of this.sessions.values()) {
      if (now - s.at <= VIEWER_IDLE_MS) {
        for (const id of s.previewIds) activeIds.add(id)
      } else {
        s.previewIds = []
      }
    }
    this.syncRemotePreviews([...activeIds])
  }

  private syncRemotePreviews(ids: string[]) {
    const list = this.deps.loadChannels()
    this.deps.previews.syncRemote(ids, (id) => list.find((c) => c.id === id))
  }

  private getToken(req: IncomingMessage): string | null {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      const t = auth.slice(7).trim()
      if (t) return t
    }
    const cookie = req.headers.cookie ?? ''
    const m = /(?:^|;\s*)nm_remote_token=([^;]+)/.exec(cookie)
    if (m?.[1]) return decodeURIComponent(m[1])
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port || 80}`)
      const q = url.searchParams.get('token')
      if (q) return q
    } catch {
      /* ignore */
    }
    return null
  }

  private requireSession(req: IncomingMessage): Session | null {
    const token = this.getToken(req)
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s) return null
    if (Date.now() - s.at > TOKEN_TTL_MS) {
      this.sessions.delete(token)
      return null
    }
    s.at = Date.now()
    return s
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port || 80}`)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      res.end()
      return
    }

    if (path === '/api/login' && req.method === 'POST') {
      await this.handleLogin(req, res)
      return
    }

    if (path === '/api/logout' && req.method === 'POST') {
      const token = this.getToken(req)
      if (token) this.sessions.delete(token)
      this.pruneSessions()
      sendJson(res, 200, { ok: true })
      return
    }

    if (path === '/api/status' && req.method === 'GET') {
      const meta = this.deps.getAppMeta()
      const settings = loadSettings()
      sendJson(res, 200, {
        ok: true,
        username: settings.remoteUsername || REMOTE_USERNAME,
        listening: true,
        name: meta.name,
        version: meta.version,
        license: meta.license,
        copyright: meta.copyright,
        homepage: meta.homepage,
        licenseNote: meta.licenseNote,
      })
      return
    }

    if (path.startsWith('/api/') || path.startsWith('/media/')) {
      const session = this.requireSession(req)
      if (!session) {
        if (path.startsWith('/media/')) {
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        sendJson(res, 401, { error: '未登录' })
        return
      }

      if (path === '/api/bootstrap' && req.method === 'GET') {
        const settings = loadSettings()
        const meta = this.deps.getAppMeta()
        sendJson(res, 200, {
          channels: this.deps.loadChannels().map((c) => ({
            id: c.id,
            name: c.name,
            group: c.group,
            enabled: c.enabled,
            url: '',
          })),
          groupOrder: this.deps.getGroupOrder(),
          states: mapStatesForRemote(this.deps.allStates()),
          uiTheme: settings.uiTheme,
          app: meta,
        })
        return
      }

      if (path === '/api/states' && req.method === 'GET') {
        sendJson(res, 200, { states: mapStatesForRemote(this.deps.allStates()) })
        return
      }

      if (path === '/api/previews' && req.method === 'POST') {
        const raw = await readBody(req)
        let ids: string[] = []
        try {
          const body = JSON.parse(raw || '{}') as { channelIds?: unknown }
          if (Array.isArray(body.channelIds)) {
            ids = body.channelIds.filter((x): x is string => typeof x === 'string' && !!x)
          }
        } catch {
          sendJson(res, 400, { error: '无效请求' })
          return
        }
        session.previewIds = [...new Set(ids)].slice(0, 16)
        session.at = Date.now()
        // Merge all sessions' preview demand
        const active = new Set<string>()
        for (const s of this.sessions.values()) {
          for (const id of s.previewIds) active.add(id)
        }
        this.syncRemotePreviews([...active])
        sendJson(res, 200, {
          ok: true,
          states: mapStatesForRemote(this.deps.allStates()),
        })
        return
      }

      if (path === '/api/recordings' && req.method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://local').searchParams
        const channelId = q.get('channelId') || undefined
        const segs = this.deps.listRecordings(channelId || undefined)
        sendJson(res, 200, { segments: mapSegmentsForRemote(segs) })
        return
      }

      if (path === '/api/saved-clips' && req.method === 'GET') {
        const q = new URL(req.url ?? '/', 'http://local').searchParams
        const channelId = q.get('channelId') || undefined
        const segs = this.deps.listSavedClips(channelId || undefined)
        sendJson(res, 200, { segments: mapSegmentsForRemote(segs) })
        return
      }

      const mediaParts = path.split('/').filter(Boolean)
      const mediaUrl = new URL(req.url ?? '/', 'http://local')

      // /media/vod/:channelId/start/:startMs/end/:endMs/index.m3u8
      if (
        mediaParts[0] === 'media' &&
        mediaParts[1] === 'vod' &&
        mediaParts[2] &&
        mediaParts[3] === 'start' &&
        mediaParts[5] === 'end' &&
        mediaParts[7] === 'index.m3u8' &&
        mediaParts[4] &&
        mediaParts[6]
      ) {
        const channelId = decodeURIComponent(mediaParts[2])
        const startMs = Number(mediaParts[4])
        const endMs = Number(mediaParts[6])
        const source = mediaUrl.searchParams.get('source') === 'saved' ? 'saved' : 'loop'
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
          res.writeHead(400)
          res.end('bad range')
          return
        }
        const kind = source === 'saved' ? 'saved' : 'recordings'
        const playlist = this.deps.media.buildVodPlaylist({
          channelId,
          startMs,
          endMs,
          source,
          mediaPrefix: `/media/${kind}/${encodeURIComponent(channelId)}`,
        })
        if (!playlist) {
          res.writeHead(404)
          res.end('no recordings in range')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
        })
        res.end(playlist.body)
        return
      }

      // /media/preview/:id/live.ts
      if (
        mediaParts[0] === 'media' &&
        mediaParts[1] === 'preview' &&
        mediaParts[3] === 'live.ts' &&
        mediaParts[2]
      ) {
        const channelId = decodeURIComponent(mediaParts[2])
        this.deps.media.subscribeLiveStream(channelId, req, res)
        return
      }

      // /media/recordings/:channelId/:fileName
      if (mediaParts[0] === 'media' && mediaParts[1] === 'recordings' && mediaParts[2] && mediaParts[3]) {
        const channelId = decodeURIComponent(mediaParts[2])
        const fileName = decodeURIComponent(mediaParts.slice(3).join('/'))
        const file = resolveMediaFile('recordings', channelId, fileName)
        if (!file) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        this.deps.media.serveFile(file, req, res)
        return
      }

      // /media/saved/:channelId/:fileName
      if (mediaParts[0] === 'media' && mediaParts[1] === 'saved' && mediaParts[2] && mediaParts[3]) {
        const channelId = decodeURIComponent(mediaParts[2])
        const fileName = decodeURIComponent(mediaParts.slice(3).join('/'))
        const file = resolveMediaFile('saved', channelId, fileName)
        if (!file) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        this.deps.media.serveFile(file, req, res)
        return
      }

      sendJson(res, 404, { error: 'not found' })
      return
    }

    await this.serveStatic(req, res, path)
  }

  private async handleLogin(req: IncomingMessage, res: ServerResponse) {
    const raw = await readBody(req)
    let username = ''
    let password = ''
    try {
      const body = JSON.parse(raw || '{}') as { username?: unknown; password?: unknown }
      username = typeof body.username === 'string' ? body.username.trim() : ''
      password = typeof body.password === 'string' ? body.password : ''
    } catch {
      sendJson(res, 400, { error: '无效请求' })
      return
    }
    const settings = loadSettings()
    const expectedUser = settings.remoteUsername || REMOTE_USERNAME
    const okUser = safeEqualStr(username, expectedUser)
    const expected = settings.remotePassword || ''
    const okPass = expected.length > 0 && safeEqualStr(password, expected)
    if (!okUser || !okPass) {
      sendJson(res, 401, { error: '用户名或密码错误' })
      return
    }
    const token = randomBytes(24).toString('base64url')
    this.sessions.set(token, { token, at: Date.now(), previewIds: [] })
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': `nm_remote_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify({ ok: true, token, username: expectedUser }))
  }

  private async serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const vite = this.deps.getViteDevUrl()
    if (vite) {
      await this.proxyVite(req, res, vite, pathname)
      return
    }

    const root = this.deps.getStaticRoot()
    let rel = pathname === '/' ? 'remote.html' : pathname.replace(/^\//, '')
    if (rel === 'index.html') rel = 'remote.html'
    // strip query — already from pathname
    const file = safeJoin(root, rel.split('/'))
    if (file && existsSync(file) && !statSync(file).isDirectory()) {
      this.sendFile(file, res)
      return
    }
    // SPA fallback
    const fallback = join(root, 'remote.html')
    if (existsSync(fallback)) {
      this.sendFile(fallback, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Remote UI not found. Run a production build first.')
  }

  private async proxyVite(
    req: IncomingMessage,
    res: ServerResponse,
    viteBase: string,
    pathname: string,
  ) {
    const targetPath = pathname === '/' ? '/remote.html' : pathname
    const target = `${viteBase.replace(/\/$/, '')}${targetPath}${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
    try {
      const headers: Record<string, string> = {}
      const accept = req.headers.accept
      if (accept) headers.Accept = accept
      const r = await fetch(target, { headers })
      const buf = Buffer.from(await r.arrayBuffer())
      const ct = r.headers.get('content-type') || STATIC_MIME[extname(targetPath)] || 'application/octet-stream'
      res.writeHead(r.status, {
        'Content-Type': ct,
        'Cache-Control': 'no-store',
      })
      res.end(buf)
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`Vite proxy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private sendFile(file: string, res: ServerResponse) {
    const st = statSync(file)
    const ct = STATIC_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': st.size,
      'Cache-Control': extname(file) === '.html' ? 'no-store' : 'public, max-age=60',
    })
    createReadStream(file).pipe(res)
  }
}
