import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'
import { recordingsRoot, savedClipsRoot } from './data-root'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
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
 * Localhost-only server: recordings files + live MPEG-TS preview streams.
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
    const base = this.baseUrl ?? ''
    return `${base}/recordings/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
  }

  savedClipUrl(channelId: string, fileName: string): string {
    const base = this.baseUrl ?? ''
    return `${base}/saved/${encodeURIComponent(channelId)}/${encodeURIComponent(fileName)}`
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
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }

    if (parts[0] === 'recordings') {
      const file = safeJoin(recordingsRoot(), parts.slice(1))
      if (!file || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      this.sendFile(file, res)
      return
    }

    if (parts[0] === 'saved') {
      const file = safeJoin(savedClipsRoot(), parts.slice(1))
      if (!file || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      this.sendFile(file, res)
      return
    }

    // /preview/<id>/live.ts
    if (parts[0] === 'preview' && parts[2] === 'live.ts' && parts[1]) {
      const channelId = decodeURIComponent(parts[1])
      this.subscribeLiveStream(channelId, req, res)
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
      this.sendFile(file, res, { noCache: true })
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

  private sendFile(
    file: string,
    res: ServerResponse,
    opts?: { noCache?: boolean },
  ) {
    const st = statSync(file)
    const headers: Record<string, string | number> = {
      'Content-Type': contentType(file),
      'Content-Length': st.size,
      'Access-Control-Allow-Origin': '*',
    }
    if (opts?.noCache) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    } else {
      headers['Cache-Control'] = 'public, max-age=60'
    }
    res.writeHead(200, headers)
    createReadStream(file).pipe(res)
  }
}

export function previewDirFor(channelId: string, previewRoot: string): string {
  return join(previewRoot, channelId)
}
