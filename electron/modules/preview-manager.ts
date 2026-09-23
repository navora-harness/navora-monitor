import { ChildProcess, spawn } from 'node:child_process'
import { buildMpegtsPreviewArgs } from '../../shared/ffmpeg-args'
import type { ChannelConfig, ChannelRuntimeState, PreviewStatus } from '../../shared/types'
import { previewRoot } from './data-root'
import type { MediaServer } from './media-server'
import { probeFfmpeg, resolveFfmpegPath } from './ffmpeg/resolve'
import { loadSettings } from './settings-store'

type Session = {
  channelId: string
  proc: ChildProcess
  status: PreviewStatus
  previewUrl: string
  lastError: string | null
  restartAttempt: number
  stopping: boolean
  generation: number
}

export function getPreviewRoot(): string {
  return previewRoot()
}

export class PreviewManager {
  private sessions = new Map<string, Session>()
  private media: MediaServer
  private ffmpegPath: string | null = null
  private generation = 0
  /** Channels requested by the local Electron UI */
  private desktopIds = new Set<string>()
  /** Channels requested by remote browser viewers */
  private remoteIds = new Set<string>()
  private resolveChannel: ((id: string) => ChannelConfig | undefined) | null = null

  constructor(media: MediaServer) {
    this.media = media
  }

  refreshFfmpeg() {
    const preferred = loadSettings().ffmpegPath || null
    this.ffmpegPath = resolveFfmpegPath(preferred)
    return this.ffmpegPath && probeFfmpeg(this.ffmpegPath) ? this.ffmpegPath : null
  }

  private ffmpeg(): string | null {
    if (!this.ffmpegPath) this.refreshFfmpeg()
    return this.ffmpegPath && probeFfmpeg(this.ffmpegPath) ? this.ffmpegPath : null
  }

  getPreviewSlice(channelId: string): Pick<ChannelRuntimeState, 'preview' | 'previewUrl' | 'previewError'> {
    const s = this.sessions.get(channelId)
    if (!s) return { preview: 'idle', previewUrl: null, previewError: null }
    const dead = s.proc.exitCode !== null || s.proc.signalCode !== null
    if (dead && !s.stopping) {
      return {
        preview: s.lastError ? 'error' : 'idle',
        previewUrl: s.previewUrl,
        previewError: s.lastError,
      }
    }
    return {
      preview: s.status,
      previewUrl: s.previewUrl,
      previewError: s.lastError,
    }
  }

  start(channel: ChannelConfig): Pick<ChannelRuntimeState, 'preview' | 'previewUrl' | 'previewError'> {
    const existing = this.sessions.get(channel.id)
    if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null && !existing.stopping) {
      return this.getPreviewSlice(channel.id)
    }

    // Invalidate any pending restart / leftover dead session before spawning again
    const prevAttempt = existing?.restartAttempt ?? 0
    if (existing) {
      existing.stopping = true
      try {
        if (existing.proc.exitCode === null && existing.proc.signalCode === null) existing.proc.kill()
      } catch {
        /* ignore */
      }
      this.sessions.delete(channel.id)
      this.media.closeLive(channel.id)
    }

    const ffmpeg = this.ffmpeg()
    if (!ffmpeg) {
      return {
        preview: 'error',
        previewUrl: null,
        previewError: '未找到可用的 ffmpeg',
      }
    }
    if (!channel.enabled) {
      return { preview: 'error', previewUrl: null, previewError: '通道已停用' }
    }

    if (!this.media.baseUrl) {
      return {
        preview: 'error',
        previewUrl: null,
        previewError: '本地预览服务未启动',
      }
    }

    const inputUrl = channel.previewUrl?.trim() || channel.url
    const args = buildMpegtsPreviewArgs({
      inputUrl,
      rtspTransport: channel.rtspTransport ?? loadSettings().defaultRtspTransport ?? 'tcp',
    })

    this.media.openLive(channel.id)
    const previewUrl = this.media.previewStreamUrl(channel.id)
    const generation = ++this.generation

    const proc = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const session: Session = {
      channelId: channel.id,
      proc,
      status: 'starting',
      previewUrl,
      lastError: null,
      restartAttempt: prevAttempt,
      stopping: false,
      generation,
    }
    this.sessions.set(channel.id, session)

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000)
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (session.stopping) return
      if (this.sessions.get(channel.id) !== session) return
      if (session.status !== 'live') session.status = 'live'
      session.lastError = null
      this.media.broadcastLive(channel.id, chunk)
    })

    proc.on('exit', (code, signal) => {
      if (this.sessions.get(channel.id) === session) {
        this.media.closeLive(channel.id)
      }
      if (session.stopping) {
        if (this.sessions.get(channel.id) === session) this.sessions.delete(channel.id)
        return
      }
      session.lastError =
        summarizeFfmpegError(stderrBuf) || `ffmpeg 退出 code=${code} signal=${signal}`
      session.status = 'error'
      const attempt = session.restartAttempt + 1
      session.restartAttempt = attempt
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 4))
      setTimeout(() => {
        // Stale restart must not kill a newer session started by sync/repair
        if (session.stopping) return
        if (this.sessions.get(channel.id) !== session) return
        this.sessions.delete(channel.id)
        const slice = this.start({ ...channel })
        const s2 = this.sessions.get(channel.id)
        if (s2) s2.restartAttempt = attempt
        void slice
      }, delay)
    })

    proc.on('error', (err) => {
      if (this.sessions.get(channel.id) === session) this.media.closeLive(channel.id)
      session.lastError = err.message
      session.status = 'error'
    })

    return this.getPreviewSlice(channel.id)
  }

  stop(channelId: string): void {
    const s = this.sessions.get(channelId)
    if (!s) return
    s.stopping = true
    this.media.closeLive(channelId)
    try {
      s.proc.kill()
    } catch {
      /* ignore */
    }
    this.sessions.delete(channelId)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  /** Local window preview set (alias kept for existing callers). */
  syncActive(channelIds: string[], resolveChannel: (id: string) => ChannelConfig | undefined) {
    this.syncDesktop(channelIds, resolveChannel)
  }

  syncDesktop(channelIds: string[], resolveChannel: (id: string) => ChannelConfig | undefined) {
    this.desktopIds = new Set(channelIds.filter(Boolean))
    this.resolveChannel = resolveChannel
    this.applyMerged()
  }

  syncRemote(channelIds: string[], resolveChannel?: (id: string) => ChannelConfig | undefined) {
    this.remoteIds = new Set(channelIds.filter(Boolean))
    if (resolveChannel) this.resolveChannel = resolveChannel
    this.applyMerged()
  }

  private applyMerged() {
    const resolve = this.resolveChannel
    if (!resolve) return
    const want = new Set([...this.desktopIds, ...this.remoteIds])
    for (const id of [...this.sessions.keys()]) {
      if (!want.has(id)) this.stop(id)
    }
    for (const id of want) {
      const ch = resolve(id)
      if (!ch?.enabled) {
        this.stop(id)
        continue
      }
      this.start(ch)
    }
  }

  /** Force restart preview with latest channel config (URL / transport / etc.). */
  restart(channel: ChannelConfig): Pick<ChannelRuntimeState, 'preview' | 'previewUrl' | 'previewError'> {
    this.stop(channel.id)
    return this.start(channel)
  }
}

function summarizeFfmpegError(stderr: string): string | null {
  const text = stderr.trim()
  if (!text) return null
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const interesting =
    lines.filter(
      (l) =>
        /error|fail|invalid|denied|refused|timed out|404|401|403|hevc|h265|codec/i.test(l) &&
        !/^frame=/i.test(l),
    ) ?? []
  const pick = interesting.at(-1) ?? lines.at(-1)
  if (!pick) return null
  return pick.length > 240 ? `${pick.slice(0, 240)}…` : pick
}
