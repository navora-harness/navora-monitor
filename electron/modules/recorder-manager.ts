import { ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildSegmentRecordArgs, sanitizeFileStem } from '../../shared/ffmpeg-args'
import type { ChannelConfig, ChannelRuntimeState } from '../../shared/types'
import { channelWriteDir } from './data-root'
import { probeFfmpeg, resolveFfmpegPath } from './ffmpeg/resolve'
import { loadSettings } from './settings-store'
import { segmentFlusher } from './segment-flusher'

type Session = {
  channelId: string
  proc: ChildProcess
  outputDir: string
  cached: boolean
  startedAt: string
  lastError: string | null
}

/**
 * Owns FFmpeg child processes for segmented recording.
 * When record cache is active, writes to local cache; SegmentFlusher moves
 * completed segments to the archive recordings path.
 */
export class RecorderManager {
  private sessions = new Map<string, Session>()
  private ffmpegPath: string | null = null
  private ffmpegOk = false

  refreshFfmpeg(): { path: string | null; ok: boolean } {
    const preferred = loadSettings().ffmpegPath || null
    this.ffmpegPath = resolveFfmpegPath(preferred)
    this.ffmpegOk = this.ffmpegPath ? probeFfmpeg(this.ffmpegPath) : false
    return { path: this.ffmpegPath, ok: this.ffmpegOk }
  }

  getFfmpegInfo(): { path: string | null; ok: boolean } {
    if (this.ffmpegPath === null) this.refreshFfmpeg()
    return { path: this.ffmpegPath, ok: this.ffmpegOk }
  }

  getState(channelId: string): ChannelRuntimeState {
    const s = this.sessions.get(channelId)
    if (!s) {
      return {
        id: channelId,
        recording: 'idle',
        pid: null,
        lastError: null,
        outputDir: null,
        startedAt: null,
        preview: 'idle',
        previewUrl: null,
        previewError: null,
      }
    }
    const dead = s.proc.exitCode !== null || s.proc.signalCode !== null
    return {
      id: channelId,
      recording: dead ? (s.lastError ? 'error' : 'idle') : 'recording',
      pid: s.proc.pid ?? null,
      lastError: s.lastError,
      outputDir: s.outputDir,
      startedAt: s.startedAt,
      preview: 'idle',
      previewUrl: null,
      previewError: null,
    }
  }

  listStates(channelIds: string[]): ChannelRuntimeState[] {
    return channelIds.map((id) => this.getState(id))
  }

  start(channel: ChannelConfig): ChannelRuntimeState {
    const existing = this.sessions.get(channel.id)
    if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) {
      return this.getState(channel.id)
    }

    const { path, ok } = this.getFfmpegInfo()
    if (!path || !ok) {
      return {
        id: channel.id,
        recording: 'error',
        pid: null,
        lastError: '未找到可用的 ffmpeg，请安装并加入 PATH，或设置 NAVORA_MONITOR_FFMPEG',
        outputDir: null,
        startedAt: null,
        preview: 'idle',
        previewUrl: null,
        previewError: null,
      }
    }

    if (!channel.enabled) {
      return {
        id: channel.id,
        recording: 'error',
        pid: null,
        lastError: '通道已停用',
        outputDir: null,
        startedAt: null,
        preview: 'idle',
        previewUrl: null,
        previewError: null,
      }
    }

    const settings = loadSettings()
    const { dir: outputDir, cached } = channelWriteDir(channel.id)
    const stem = sanitizeFileStem(channel.name || channel.id)
    const outputPattern = join(outputDir, `${stem}-%03d.mp4`)
    const args = buildSegmentRecordArgs({
      inputUrl: channel.url,
      outputPattern,
      title: channel.name,
      segmentTimeSec: channel.segmentTimeSec ?? settings.defaultSegmentTimeSec,
      rtspTransport: channel.rtspTransport ?? settings.defaultRtspTransport,
    })

    const proc = spawn(path, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    const session: Session = {
      channelId: channel.id,
      proc,
      outputDir,
      cached,
      startedAt: new Date().toISOString(),
      lastError: null,
    }
    this.sessions.set(channel.id, session)

    if (cached) segmentFlusher.startChannel(channel.id)

    let stderrBuf = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000)
    })

    proc.on('exit', (code, signal) => {
      if (code && code !== 0) {
        session.lastError = stderrBuf.trim() || `ffmpeg 退出 code=${code} signal=${signal}`
      }
      if (session.cached) {
        void segmentFlusher.stopChannel(channel.id)
      }
    })

    proc.on('error', (err) => {
      session.lastError = err.message
    })

    return this.getState(channel.id)
  }

  stop(channelId: string): ChannelRuntimeState {
    const s = this.sessions.get(channelId)
    if (!s) return this.getState(channelId)

    try {
      if (process.platform === 'win32') {
        s.proc.kill()
      } else {
        s.proc.kill('SIGTERM')
      }
    } catch {
      /* already dead */
    }

    if (s.cached) {
      void segmentFlusher.stopChannel(channelId)
    }

    setTimeout(() => {
      const cur = this.sessions.get(channelId)
      if (cur === s && (s.proc.exitCode !== null || s.proc.signalCode !== null)) {
        if (!s.lastError) this.sessions.delete(channelId)
      }
    }, 500)

    return this.getState(channelId)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.stop(id)
    }
  }

  activeCount(): number {
    let n = 0
    for (const s of this.sessions.values()) {
      if (s.proc.exitCode === null && s.proc.signalCode === null) n += 1
    }
    return n
  }

  /** Active FFmpeg sessions (for write-rate / capacity estimation). */
  listActiveSessions(): Array<{ channelId: string; outputDir: string; startedAt: string }> {
    const out: Array<{ channelId: string; outputDir: string; startedAt: string }> = []
    for (const s of this.sessions.values()) {
      if (s.proc.exitCode !== null || s.proc.signalCode !== null) continue
      out.push({ channelId: s.channelId, outputDir: s.outputDir, startedAt: s.startedAt })
    }
    return out
  }
}
