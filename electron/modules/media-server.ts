import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { decodeMediaParts, localRecordingUrl, localSavedClipUrl, parseMediaUrl, resolveMediaFile } from './media-protocol'
import { getChannelVodPlaylist, vodUrlLocal, type VodSource } from './vod-playlist'
import { serveTsRemuxAsMp4 } from './ffmpeg/fmp4-playback-stream'
import { probeFfmpeg, resolveFfmpegPath } from './ffmpeg/resolve'
import { loadSettings } from './settings-store'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mkv': 'video/x-matroska',
  '.m4s': 'video/iso.segment',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function safeJoin(root: string, parts: string[]): string | null {
  const target = resolve(root, ...parts)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`) || normalize(rel).startsWith('..')) {
    return null
  }
  return target
}

type LiveChannel = {
  subscribers: Set<ServerResponse>
  /** Ring of recent packets so new viewers sync faster */
  preamble: Buffer[]
  preambleBytes: number
}

const PREAMBLE_MAX = 512 * 1024

/**
 * Localhost HTTP for live preview + recording / saved-clip Range downloads.
 * Desktop playback always uses http://127.0.0.1 (mpegts.js needs Range).
 * navora:// is only a last-resort fallback before the HTTP server is listening.
 */
export class MediaServer {
  private server: Server | null = null
  private port = 0
  private previewRoot = ''
  private live = new Map<string, LiveChannel>()

  get baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  setPreviewRoot(dir: string) {
    this.previewRoot = dir
  }

  async start(): Promise<string> {
    if (this.server && this.port) return `http://127.0.0.1:${this.port}`

    this.server = createServer((req, res) => {
      try {
        this.handle(req, res)
      } catch {
        if (!res.headersSent) res.writeHead(500)
        res.end('error')
      }
    })

    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        resolvePromise()
      })
    })

    return `http://127.0.0.1:${this.port}`
  }

  stop() {
    for (const ch of this.live.values()) {
      for (const res of ch.subscribers) {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    }
    this.live.clear()
    this.server?.close()
    this.server = null
    this.port = 0
  }

  recordingUrl(channelId: string, fileName: string): string {
    const base = this.baseUrl
    if (base) {
      return `${base}/recordings/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
    }
    console.warn('[media] recordingUrl before HTTP listen — temporary navora:// fallback')
    return localRecordingUrl(channelId, fileName)
  }

  savedClipUrl(channelId: string, fileName: string): string {
    const base = this.baseUrl
    if (base) {
      return `${base}/saved/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
    }
    console.warn('[media] savedClipUrl before HTTP listen — temporary navora:// fallback')
    return localSavedClipUrl(channelId, fileName)
  }

  /** Wall-clock window HLS VOD playlist URL (desktop localhost). */
  vodPlaylistUrl(
    channelId: string,
    startMs: number,
    endMs: number,
    source: VodSource = 'loop',
  ): string | null {
    const base = this.baseUrl
    if (!base) return null
    return vodUrlLocal(base, channelId, startMs, endMs, source)
  }

  /** Generate VOD m3u8 body for local or remote prefix. */
  buildVodPlaylist(opts: {
    channelId: string
    startMs: number
    endMs: number
    source?: VodSource
    /** Default `/recordings/<id>` (local) or `/media/recordings/<id>` (remote). */
    mediaPrefix?: string
  }) {
    const kind = opts.source === 'saved' ? 'saved' : 'recordings'
    const mediaPrefix =
      opts.mediaPrefix ?? `/${kind}/${encodeURIComponent(opts.channelId)}`
    return getChannelVodPlaylist({
      channelId: opts.channelId,
      startMs: opts.startMs,
      endMs: opts.endMs,
      source: opts.source,
      mediaPrefix,
    })
  }

  /** Live low-latency MPEG-TS endpoint for mpegts.js */
  previewStreamUrl(channelId: string): string {
    const base = this.baseUrl ?? ''
    return `${base}/preview/${encodeURIComponent(channelId)}/live.ts`
  }

  /** @deprecated HLS index — keep for compatibility */
  previewIndexUrl(channelId: string): string {
    return this.previewStreamUrl(channelId)
  }

  openLive(channelId: string) {
    if (!this.live.has(channelId)) {
      this.live.set(channelId, { subscribers: new Set(), preamble: [], preambleBytes: 0 })
    }
  }

  closeLive(channelId: string) {
    const ch = this.live.get(channelId)
    if (!ch) return
    for (const res of ch.subscribers) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    this.live.delete(channelId)
  }

  broadcastLive(channelId: string, chunk: Buffer) {
    let ch = this.live.get(channelId)
    if (!ch) {
      this.openLive(channelId)
      ch = this.live.get(channelId)!
    }
    ch.preamble.push(chunk)
    ch.preambleBytes += chunk.length
    while (ch.preambleBytes > PREAMBLE_MAX && ch.preamble.length > 1) {
      const dropped = ch.preamble.shift()
      if (dropped) ch.preambleBytes -= dropped.length
    }
    for (const res of [...ch.subscribers]) {
      try {
        res.write(chunk)
      } catch {
        ch.subscribers.delete(res)
      }
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }

    const parsed = (() => {
      try {
        return parseMediaUrl(url.href)
      } catch {
        return null
      }
    })()

    if (parsed) {
      const file = resolveMediaFile(parsed.kind, parsed.channelId, parsed.fileName)
      if (!file) {
        console.warn(`[media] 404 ${parsed.kind}/${parsed.channelId}/${parsed.fileName}`)
        res.writeHead(404)
        res.end('not found')
        return
      }
      this.sendFile(file, req, res)
      return
    }

    const parts = decodeMediaParts(url.pathname.split('/').filter(Boolean))

    // /remux/recordings|saved/:channelId/:fileName.ts?t=offsetSec
    // FFmpeg -c copy → temp faststart MP4 → Range for native <video> (Chromium cannot open fMP4 pipes).
    if (parts[0] === 'remux' && (parts[1] === 'recordings' || parts[1] === 'saved') && parts[2] && parts[3]) {
      const kind = parts[1] as 'recordings' | 'saved'
      const channelId = parts[2]
      const fileName = parts.slice(3).join('/')
      void this.serveFmp4Remux(kind, channelId, fileName, req, res, url)
      return
    }

    // /vod/:channelId/start/:startMs/end/:endMs/index.m3u8
    if (
      parts[0] === 'vod' &&
      parts[1] &&
      parts[2] === 'start' &&
      parts[4] === 'end' &&
      parts[6] === 'index.m3u8' &&
      parts[3] &&
      parts[5]
    ) {
      const channelId = parts[1]
      const startMs = Number(parts[3])
      const endMs = Number(parts[5])
      const source = (url.searchParams.get('source') === 'saved' ? 'saved' : 'loop') as VodSource
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        res.writeHead(400)
        res.end('bad range')
        return
      }
      const kind = source === 'saved' ? 'saved' : 'recordings'
      const playlist = this.buildVodPlaylist({
        channelId,
        startMs,
        endMs,
        source,
        mediaPrefix: `/${kind}/${encodeURIComponent(channelId)}`,
      })
      if (!playlist) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' })
        res.end('no recordings in range')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(playlist.body)
      return
    }

    // /preview/<id>/live.ts
    if (parts[0] === 'preview' && parts[2] === 'live.ts' && parts[1]) {
      this.subscribeLiveStream(parts[1], req, res)
      return
    }

    // legacy static HLS files if any remain
    if (parts[0] === 'preview' && this.previewRoot) {
      const file = safeJoin(this.previewRoot, parts.slice(1))
      if (!file || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      this.sendFile(file, req, res, { noCache: true })
      return
    }

    res.writeHead(404)
    res.end('not found')
  }

  /** Attach an HTTP response as a live MPEG-TS subscriber (also used by remote proxy). */
  subscribeLiveStream(channelId: string, req: IncomingMessage, res: ServerResponse) {
    this.openLive(channelId)
    const ch = this.live.get(channelId)!
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    for (const buf of ch.preamble) {
      res.write(buf)
    }
    ch.subscribers.add(res)
    const cleanup = () => {
      ch.subscribers.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  /** Serve a file with Range support (also used by remote proxy). */
  serveFile(file: string, req: IncomingMessage, res: ServerResponse, opts?: { noCache?: boolean }) {
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    this.sendFile(file, req, res, opts)
  }

  /**
   * Remux a finished .ts to a temp faststart MP4 and Range-serve it.
   * Query `t` = start offset seconds (FFmpeg -ss before -i).
   * Temp files live under OS tempdir — not in the recordings tree.
   */
  private async serveFmp4Remux(
    kind: 'recordings' | 'saved',
    channelId: string,
    fileName: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) {
    if (!fileName.toLowerCase().endsWith('.ts')) {
      res.writeHead(400, { 'Access-Control-Allow-Origin': '*' })
      res.end('expected .ts')
      return
    }
    const file = resolveMediaFile(kind, channelId, fileName)
    if (!file) {
      console.warn(`[media] remux 404 ${kind}/${channelId}/${fileName}`)
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      res.end('not found')
      return
    }

    const ffmpeg = resolveFfmpegPath(loadSettings().ffmpegPath || null)
    if (!ffmpeg || !probeFfmpeg(ffmpeg)) {
      res.writeHead(503, { 'Access-Control-Allow-Origin': '*' })
      res.end('ffmpeg unavailable')
      return
    }

    const tRaw = url.searchParams.get('t')
    const startSec = tRaw != null && tRaw !== '' ? Number(tRaw) : 0
    const start = Number.isFinite(startSec) && startSec > 0 ? startSec : 0

    await serveTsRemuxAsMp4({
      ffmpeg,
      srcPath: file,
      startSec: start,
      req,
      res,
      sendFile: (f, r, s, o) => this.sendFile(f, r, s, o),
    })
  }

  private sendFile(
    file: string,
    req: IncomingMessage,
    res: ServerResponse,
    opts?: { noCache?: boolean },
  ) {
    const st = statSync(file)
    const total = st.size
    const type = contentType(file)
    const cacheHeaders: Record<string, string> = opts?.noCache
      ? { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
      : { 'Cache-Control': 'public, max-age=60' }

    const rangeHeader = req.headers.range
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      if (!m) {
        res.writeHead(416, {
          'Content-Range': `bytes */${total}`,
          'Access-Control-Allow-Origin': '*',
        })
        res.end()
        return
      }
      let start = m[1] ? Number(m[1]) : 0
      let end = m[2] ? Number(m[2]) : total - 1
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
        res.writeHead(416, {
          'Content-Range': `bytes */${total}`,
          'Access-Control-Allow-Origin': '*',
        })
        res.end()
        return
      }
      end = Math.min(end, total - 1)
      const chunk = end - start + 1
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': chunk,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        ...cacheHeaders,
      })
      createReadStream(file, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      ...cacheHeaders,
    })
    createReadStream(file).pipe(res)
  }
}


export function previewDirFor(channelId: string, previewRoot: string): string {
  return join(previewRoot, channelId)
}
