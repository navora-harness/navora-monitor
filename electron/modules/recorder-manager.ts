import { ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildSegmentRecordArgs, sanitizeFileStem } from '../../shared/ffmpeg-args'
import { SEGMENT_STRFTIME_SUFFIX } from '../../shared/segment-time'
import type { ChannelConfig, ChannelRuntimeState } from '../../shared/types'
import { channelWriteDir } from './data-root'
import { probeFfmpeg, resolveFfmpegPath } from './ffmpeg/resolve'
import { loadSettings } from './settings-store'
import { segmentFlusher } from './segment-flusher'
import { loadRecordingSession, saveRecordingSession } from './recording-session-store'

type Session = {
  channelId: string
  proc: ChildProcess
  outputDir: string
  cached: boolean
  startedAt: string
  lastError: string | null
}

export type StartRecordOptions = {
  /** Persist so recording resumes on next app launch (default true). */
  remember?: boolean
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
  /** Channels the user wants recording across restarts (manual / resume). */
  private remembered = new Set<string>(loadRecordingSession())
  /** Intentional stops — do not auto-restart these exit events. */
  private stopping = new Set<string>()
  private restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private resolveChannel: ((id: string) => ChannelConfig | undefined) | null = null

  private persistRemembered() {
    saveRecordingSession([...this.remembered])
  }

  /** Used for crash auto-restart of remembered sessions. */
  setChannelResolver(fn: (id: string) => ChannelConfig | undefined) {
    this.resolveChannel = fn
  }

  rememberIds(): string[] {
    return [...this.remembered]
  }

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

  start(channel: ChannelConfig, opts?: StartRecordOptions): ChannelRuntimeState {
    const remember = opts?.remember !== false
    this.clearRestartTimer(channel.id)
    this.stopping.delete(channel.id)

    const existing = this.sessions.get(channel.id)
    if (existing && existing.proc.exitCode === null && existing.proc.signalCode === null) {
      if (remember && !this.remembered.has(channel.id)) {
        this.remembered.add(channel.id)
        this.persistRemembered()
      }
      return this.getState(channel.id)
    }

    // Drop dead session before respawn
    if (existing) this.sessions.delete(channel.id)

    const { path, ok } = this.getFfmpegInfo()
    if (!path || !ok) {
      if (remember) {
        this.remembered.add(channel.id)
        this.persistRemembered()
      }
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
      if (remember) {
        this.remembered.add(channel.id)
        this.persistRemembered()
      }
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
    const outputPattern = join(outputDir, `${stem}-${SEGMENT_STRFTIME_SUFFIX}`)
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
      const intentional = this.stopping.has(channel.id)
      this.stopping.delete(channel.id)
      if (!intentional && this.remembered.has(channel.id)) {
        this.scheduleRememberedRestart(channel.id)
      }
    })

    proc.on('error', (err) => {
      session.lastError = err.message
    })

    if (remember) {
      this.remembered.add(channel.id)
      this.persistRemembered()
    }

    return this.getState(channel.id)
  }

  stop(channelId: string, opts?: { forget?: boolean }): ChannelRuntimeState {
    const forget = opts?.forget !== false
    this.clearRestartTimer(channelId)
    this.stopping.add(channelId)

    const s = this.sessions.get(channelId)
    if (!s) {
      if (forget && this.remembered.delete(channelId)) this.persistRemembered()
      this.stopping.delete(channelId)
      return this.getState(channelId)
    }

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

    if (forget && this.remembered.delete(channelId)) {
      this.persistRemembered()
    }

    return this.getState(channelId)
  }

  stopAll(opts?: { forget?: boolean }): void {
    const forget = opts?.forget !== false
    for (const id of [...this.sessions.keys()]) {
      this.stop(id, { forget })
    }
    // Also clear restart timers for remembered-but-idle channels
    for (const id of [...this.restartTimers.keys()]) {
      this.clearRestartTimer(id)
    }
    if (forget && this.remembered.size) {
      this.remembered.clear()
      this.persistRemembered()
    }
  }

  /**
   * Resume / keep remembered channels recording.
   * - Keeps disabled / missing channels in the set (retry when re-enabled)
   * - Safe to call repeatedly (idempotent for already-running)
   */
  resumeRemembered(resolveChannel: (id: string) => ChannelConfig | undefined): {
    started: number
    skipped: number
    errors: string[]
  } {
    this.resolveChannel = resolveChannel
    let started = 0
    let skipped = 0
    const errors: string[] = []
    const known = new Set(this.loadKnownChannelIds(resolveChannel))

    for (const id of [...this.remembered]) {
      // Drop only truly deleted channels — keep disabled for later
      if (!known.has(id)) {
        this.remembered.delete(id)
        this.clearRestartTimer(id)
        skipped += 1
        continue
      }
      const ch = resolveChannel(id)
      if (!ch?.enabled) {
        skipped += 1
        continue
      }
      const before = this.getState(id)
      if (before.recording === 'recording') {
        continue
      }
      const state = this.start(ch, { remember: true })
      if (state.recording === 'recording') started += 1
      else {
        skipped += 1
        if (state.lastError) errors.push(`${ch.name || id}: ${state.lastError}`)
      }
    }
    this.persistRemembered()
    return { started, skipped, errors }
  }

  /** Periodic sync: start any remembered channel that is not currently recording. */
  syncRemembered(resolveChannel?: (id: string) => ChannelConfig | undefined): {
    started: number
    skipped: number
  } {
    const resolve = resolveChannel ?? this.resolveChannel
    if (!resolve) return { started: 0, skipped: 0 }
    const r = this.resumeRemembered(resolve)
    return { started: r.started, skipped: r.skipped }
  }

  private loadKnownChannelIds(resolveChannel: (id: string) => ChannelConfig | undefined): string[] {
    // Prefer probing remembered ids; also accept any id resolveChannel can find
    const out: string[] = []
    for (const id of this.remembered) {
      if (resolveChannel(id)) out.push(id)
    }
    return out
  }

  private scheduleRememberedRestart(channelId: string) {
    if (this.stopping.has(channelId)) return
    if (!this.remembered.has(channelId)) return
    this.clearRestartTimer(channelId)
    const timer = setTimeout(() => {
      this.restartTimers.delete(channelId)
      if (!this.remembered.has(channelId) || this.stopping.has(channelId)) return
      const cur = this.getState(channelId)
      if (cur.recording === 'recording') return
      const ch = this.resolveChannel?.(channelId)
      if (!ch?.enabled) return
      console.log(`[recording] auto-restart remembered channel ${channelId}`)
      this.start(ch, { remember: true })
    }, 2500)
    this.restartTimers.set(channelId, timer)
  }

  private clearRestartTimer(channelId: string) {
    const t = this.restartTimers.get(channelId)
    if (t) {
      clearTimeout(t)
      this.restartTimers.delete(channelId)
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
