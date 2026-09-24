/**
 * Streaming media engine: MPEG-TS via mpegts.js (HTTP Range) or native progressive.
 *
 * Seek policy (mpegts):
 *   - Never soft-seek mid-session on CCTV TS (MediaMSEError).
 *   - Scrub = destroy + fresh Range load, then ONE currentTime Range-seek.
 *   - Timebase is honest: report landed relative time, never fake-calibrate to the scrub target.
 * Play policy:
 *   - Gate on real MSE data; confirm currentTime advances after play().
 */

import mpegts from 'mpegts.js'
import { MediaTimeBase, isMpegTsPath, effectiveDurationSec } from './wall-time'

export type StreamEngineEvents = {
  ready: () => void
  time: (relativeSec: number) => void
  ended: () => void
  error: (message: string) => void
  buffering: (on: boolean) => void
}

type MpegtsPlayer = {
  attachMediaElement: (el: HTMLMediaElement) => void
  detachMediaElement: () => void
  load: () => void
  unload: () => void
  play: () => Promise<void>
  pause: () => void
  destroy: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
}

function isNoSourceError(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: string }).name) : ''
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return (
    name === 'NotSupportedError' ||
    /no supported sources/i.test(msg) ||
    /The element has no supported sources/i.test(msg)
  )
}

function formatMpegtsErrArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message
      if (typeof a === 'string') return a
      if (a == null) return ''
      if (typeof a === 'object') {
        const o = a as Record<string, unknown>
        const bits = [o.code, o.msg, o.message, o.type, o.details]
          .filter((x) => x != null && String(x).length)
          .map(String)
        if (bits.length) return bits.join(' ')
        try {
          return JSON.stringify(a).slice(0, 120)
        } catch {
          return ''
        }
      }
      return String(a)
    })
    .filter(Boolean)
    .join(' ')
}

function isMpegtsMseError(args: unknown[]): boolean {
  const s = formatMpegtsErrArgs(args).toLowerCase()
  return s.includes('mediamseerror') || s.includes('mse') || s.includes('mediaerror')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class StreamEngine {
  private video: HTMLVideoElement | null = null
  private player: MpegtsPlayer | null = null
  private timeBase = new MediaTimeBase()
  private loadGen = 0
  private seekGen = 0
  private seeking = false
  private pinnedRel: number | null = null
  private wallSpanSec = 30
  private mediaDurationSec: number | null = null
  private seekedHandler: (() => void) | null = null
  private seekFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private unpinTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Partial<StreamEngineEvents> = {}
  private url = ''
  private fileName = ''
  private usingMpegts = false
  private readyWait: {
    cancel: () => void
    promise: Promise<boolean>
    gen: number
  } | null = null
  /** Suppress timeupdate → follow while loading a new source. */
  private muteTime = false
  private active = true
  /** Suppress fatal UI while we intentionally rebuild after an MSE scrub glitch. */
  private mseRecovering = false
  /** Stall detection: playing but currentTime not advancing. */
  private lastAbsMedia = 0
  private lastAbsMediaAt = 0
  private stallRecoverAt = 0
  /** Frame paint detection — currentTime can advance (audio) while video is frozen. */
  private lastFrameAt = 0
  private frameWatchHandle: number | null = null
  private frameFrozenRecoverAt = 0
  private lastLoadOpts: {
    url: string
    fileName: string
    wallSpanSec: number
    startOffsetSec?: number
  } | null = null

  on<K extends keyof StreamEngineEvents>(event: K, fn: StreamEngineEvents[K]) {
    this.listeners[event] = fn as never
  }

  setActive(on: boolean) {
    this.active = on
  }

  /**
   * True when MSE/native source can actually attempt play —
   * not merely "player object exists".
   */
  get hasSource(): boolean {
    const v = this.video
    if (!v || !this.url) return false
    if (this.usingMpegts) {
      return !!this.player && v.readyState >= HTMLMediaElement.HAVE_METADATA
    }
    return !!(v.currentSrc || v.src) && v.readyState >= HTMLMediaElement.HAVE_METADATA
  }

  /** True when we can rebuild/seek the current file without a fresh URL handoff. */
  get hasSession(): boolean {
    return !!this.lastLoadOpts
  }

  attach(video: HTMLVideoElement) {
    this.video = video
    video.addEventListener('timeupdate', this.onTimeUpdate)
    video.addEventListener('playing', this.onPlaying)
    video.addEventListener('ended', this.onEnded)
    video.addEventListener('error', this.onVideoError)
  }

  detach() {
    this.cancelFrameWatch()
    const v = this.video
    if (v) {
      v.removeEventListener('timeupdate', this.onTimeUpdate)
      v.removeEventListener('playing', this.onPlaying)
      v.removeEventListener('ended', this.onEnded)
      v.removeEventListener('error', this.onVideoError)
    }
    this.destroyPlayer()
    this.video = null
  }

  get relativeSec(): number {
    if (this.pinnedRel != null) return this.pinnedRel
    const v = this.video
    if (!v || !Number.isFinite(v.currentTime)) return 0
    return this.timeBase.relativeSec(v.currentTime)
  }

  get durationSec(): number {
    return effectiveDurationSec(this.wallSpanSec, this.mediaDurationSec)
  }

  get isSeeking(): boolean {
    return this.seeking
  }

  /** Load a media URL for streaming (Range for .ts via mpegts.js). */
  async load(opts: { url: string; fileName: string; wallSpanSec: number; startOffsetSec?: number }) {
    const v = this.video
    if (!v) return
    const gen = ++this.loadGen
    const seekTok = ++this.seekGen
    this.muteTime = true
    this.lastLoadOpts = { ...opts }
    this.destroyPlayer({ clearVideo: true })
    this.timeBase.reset()
    this.seeking = false
    this.pinnedRel = opts.startOffsetSec != null && opts.startOffsetSec > 0.05 ? opts.startOffsetSec : 0
    this.mediaDurationSec = null
    this.wallSpanSec = Math.max(0.5, opts.wallSpanSec)
    this.url = opts.url
    this.fileName = opts.fileName
    this.lastAbsMedia = 0
    this.lastAbsMediaAt = 0
    this.lastFrameAt = 0

    if (!opts.url) {
      this.muteTime = false
      this.emit('error', '录像地址无效')
      return
    }

    const useTs = isMpegTsPath(opts.fileName) || isMpegTsPath(opts.url)
    this.usingMpegts = useTs
    this.emit('buffering', true)

    if (useTs) {
      const ready = await this.loadMpegts(opts.url, gen)
      if (gen !== this.loadGen) return
      if (!ready) {
        // Drop the zombie player so late demux/MSE events cannot fight the next scrub.
        this.destroyPlayer({ clearVideo: true })
        this.emit('buffering', false)
        this.emit('error', 'MPEG-TS 加载超时，请重试')
        this.muteTime = false
        return
      }
    } else {
      await this.loadNative(opts.url, gen)
      if (gen !== this.loadGen) return
    }

    this.syncMediaDuration()

    // CCTV TS: media timeline often starts at PCR ≈ tens of thousands of seconds.
    // Wait for that origin (or mpegts StartupStallJumper) before any Range seek.
    if (useTs) {
      const ok = await this.syncPcrOrigin(gen, seekTok)
      if (gen !== this.loadGen) return
      if (!ok) {
        this.emit('buffering', false)
        this.emit('error', 'MPEG-TS 时间基准未就绪')
        this.muteTime = false
        return
      }
    }

    const offset = opts.startOffsetSec ?? 0
    let landed = 0
    if (offset > 0.25) {
      this.seeking = true
      this.pinnedRel = offset
      this.emit('time', offset)
      if (useTs) {
        landed = await this.rangeSeekTo(offset, gen, seekTok)
      } else {
        await this.seekNative(offset)
        landed = this.relativeSec
      }
      if (gen !== this.loadGen) return
      this.seeking = false
    }

    this.pinnedRel = landed
    this.emit('time', landed)
    this.emit('ready')
    // Keep pin until play advances; unpin after settle
    if (this.unpinTimer) clearTimeout(this.unpinTimer)
    this.unpinTimer = setTimeout(() => {
      this.unpinTimer = null
      if (gen !== this.loadGen) return
      this.pinnedRel = null
    }, 1200)

    this.muteTime = false
    this.emit('buffering', false)
  }

  async seek(relativeSec: number) {
    const v = this.video
    if (!v) return
    const dur = this.durationSec
    const t = Math.min(dur > 0 ? dur : relativeSec, Math.max(0, relativeSec))

    // CCTV MPEG-TS: in-place currentTime seek → MediaMSEError. Fresh Range load.
    if (this.usingMpegts && this.lastLoadOpts) {
      await this.reloadMpegtsAt(t)
      return
    }

    if (!this.hasSource) {
      if (this.lastLoadOpts) {
        await this.load({ ...this.lastLoadOpts, startOffsetSec: t })
      }
      return
    }

    await this.seekNative(t)
  }

  /** Native / progressive seek via currentTime. */
  private async seekNative(t: number) {
    const v = this.video
    if (!v) return
    const dur = this.durationSec
    const gen = ++this.seekGen
    this.seeking = true
    this.pinnedRel = t
    this.emit('buffering', true)
    this.emit('time', t)

    this.clearSeekedListeners()
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        if (gen !== this.seekGen) {
          resolve()
          return
        }
        this.clearSeekedListeners()
        if (!Number.isFinite(v.currentTime)) {
          this.seeking = false
          this.pinnedRel = t
          this.emit('time', t)
          this.emit('buffering', false)
          resolve()
          return
        }
        const got = this.timeBase.relativeSec(v.currentTime)
        const settled = Math.min(dur > 0 ? dur : got, Math.max(0, got))
        this.timeBase.calibrateFromSeeked(v.currentTime, settled)
        this.pinnedRel = settled
        this.emit('time', settled)
        this.seeking = false
        this.emit('buffering', false)
        if (this.unpinTimer) clearTimeout(this.unpinTimer)
        this.unpinTimer = setTimeout(() => {
          this.unpinTimer = null
          if (gen !== this.seekGen) return
          this.pinnedRel = null
        }, 400)
        resolve()
      }
      this.seekedHandler = onSeeked
      v.addEventListener('seeked', onSeeked)
      try {
        v.currentTime = this.timeBase.ready ? this.timeBase.absoluteSec(t) : t
      } catch {
        /* not ready — fall through to timeout */
      }
      this.seekFallbackTimer = setTimeout(() => {
        this.seekFallbackTimer = null
        if (gen !== this.seekGen) return
        if (this.seeking) onSeeked()
      }, 1000)
    })
  }

  /**
   * Destroy + recreate mpegts player, then Range-seek once on the fresh session.
   */
  private async reloadMpegtsAt(offsetSec: number) {
    const opts = this.lastLoadOpts
    if (!opts || !this.video) return
    const gen = ++this.loadGen
    const seekTok = ++this.seekGen
    const target = Math.max(0, offsetSec)
    this.muteTime = true
    this.seeking = true
    this.pinnedRel = target
    this.timeBase.reset()
    this.emit('buffering', true)
    this.emit('time', target)

    this.destroyPlayer({ clearVideo: true })
    this.usingMpegts = true
    this.url = opts.url
    this.fileName = opts.fileName
    this.wallSpanSec = opts.wallSpanSec
    this.lastLoadOpts = { ...opts, startOffsetSec: target }
    this.lastAbsMedia = 0
    this.lastAbsMediaAt = 0
    this.lastFrameAt = 0

    const ready = await this.loadMpegts(opts.url, gen)
    if (gen !== this.loadGen || seekTok !== this.seekGen) return
    if (!ready) {
      this.destroyPlayer({ clearVideo: true })
      this.seeking = false
      this.muteTime = false
      this.emit('buffering', false)
      this.emit('error', 'MPEG-TS 定位失败，请重试')
      return
    }

    const ok = await this.syncPcrOrigin(gen, seekTok)
    if (gen !== this.loadGen || seekTok !== this.seekGen) return
    if (!ok) {
      this.seeking = false
      this.muteTime = false
      this.emit('buffering', false)
      this.emit('error', 'MPEG-TS 时间基准未就绪')
      return
    }

    const landed = target > 0.25 ? await this.rangeSeekTo(target, gen, seekTok) : 0
    if (gen !== this.loadGen || seekTok !== this.seekGen) return

    this.syncMediaDuration()
    this.seeking = false
    this.muteTime = false
    this.pinnedRel = landed
    this.emit('time', landed)
    this.emit('ready')
    this.emit('buffering', false)
    if (this.unpinTimer) clearTimeout(this.unpinTimer)
    this.unpinTimer = setTimeout(() => {
      this.unpinTimer = null
      if (seekTok !== this.seekGen) return
      this.pinnedRel = null
    }, 1200)
  }

  /**
   * Align MediaTimeBase to CCTV PCR / buffered start before seeking.
   *
   * mpegts StartupStallJumper logs "stuck at 0, seek to <buffered.start>" when
   * the file timeline does not begin at 0. If we Range-seek before that, we aim
   * at wall-offset seconds on a 0-origin clock and freeze on the next scrub.
   */
  private async syncPcrOrigin(gen: number, seekTok: number): Promise<boolean> {
    const v = this.video
    if (!v) return false

    const deadline = performance.now() + 4500
    while (performance.now() < deadline) {
      if (gen !== this.loadGen || seekTok !== this.seekGen) return false

      const bufStart = this.firstBufferedStart(v)
      const ct = v.currentTime

      if (bufStart != null && bufStart > 1) {
        // Playhead still before the only buffered range — same fix as StallJumper.
        if (!Number.isFinite(ct) || ct < bufStart - 0.15) {
          await this.waitCurrentTimeSeek(bufStart, gen, seekTok)
          continue
        }
        this.timeBase.reset()
        this.timeBase.calibrateFromSeeked(bufStart, 0)
        return true
      }

      // StallJumper (or decoder) already jumped onto the PCR timeline.
      if (Number.isFinite(ct) && ct > 30) {
        this.timeBase.reset()
        this.timeBase.calibrateFromSeeked(ct, 0)
        return true
      }

      await sleep(40)
    }

    // Last resort: lock whatever we have so callers can still try a seek.
    if (Number.isFinite(v.currentTime)) {
      this.timeBase.reset()
      this.timeBase.calibrateFromSeeked(v.currentTime, 0)
      return true
    }
    return false
  }

  private firstBufferedStart(v: HTMLMediaElement): number | null {
    try {
      if (v.buffered.length > 0) return v.buffered.start(0)
    } catch {
      /* ignore */
    }
    return null
  }

  /**
   * One Range seek on a PCR-aligned session. Returns honest landed relative time.
   */
  private async rangeSeekTo(offsetSec: number, gen: number, seekTok: number): Promise<number> {
    const v = this.video
    if (!v) return 0
    if (offsetSec <= 0.25) return 0

    if (!this.timeBase.isLocked) {
      const ok = await this.syncPcrOrigin(gen, seekTok)
      if (!ok || gen !== this.loadGen || seekTok !== this.seekGen) return 0
    }

    const abs = this.timeBase.absoluteSec(offsetSec)
    await this.waitCurrentTimeSeek(abs, gen, seekTok)
    if (gen !== this.loadGen || seekTok !== this.seekGen) return offsetSec

    let landed = this.timeBase.relativeSec(v.currentTime)
    // One retry if decoder ignored the seek
    if (!Number.isFinite(v.currentTime) || Math.abs(landed - offsetSec) > 8) {
      try {
        v.currentTime = this.timeBase.absoluteSec(offsetSec)
      } catch {
        /* ignore */
      }
      await sleep(450)
      if (gen !== this.loadGen || seekTok !== this.seekGen) return offsetSec
      landed = this.timeBase.relativeSec(v.currentTime)
    }

    const honest = Math.max(0, Number.isFinite(landed) ? landed : 0)
    this.timeBase.calibrateFromSeeked(v.currentTime, honest)
    return honest
  }

  private waitCurrentTimeSeek(absoluteSec: number, gen: number, seekTok: number): Promise<void> {
    const v = this.video
    if (!v) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        v.removeEventListener('seeked', done)
        window.clearTimeout(timer)
        window.clearInterval(watch)
        resolve()
      }
      v.addEventListener('seeked', done)
      const timer = window.setTimeout(done, 2000)
      try {
        v.currentTime = absoluteSec
      } catch {
        done()
      }
      const watch = window.setInterval(() => {
        if (gen !== this.loadGen || seekTok !== this.seekGen) done()
      }, 50)
    })
  }

  /**
   * Start playback. Reloads once if MSE was torn down.
   * Confirms decode actually advances (avoids "loaded + spinner/big-play forever").
   */
  async play(): Promise<boolean> {
    const v = this.video
    if (!v) return false

    if (!this.hasSource && this.lastLoadOpts) {
      const offset = this.pinnedRel ?? this.relativeSec
      await this.load({ ...this.lastLoadOpts, startOffsetSec: offset > 0.05 ? offset : 0 })
    }
    if (!this.url || (this.usingMpegts && !this.player)) {
      this.emit('buffering', false)
      return false
    }

    // Wait briefly for MSE data before play() — NotSupportedError is common if too early.
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await this.waitForMpegtsReady(v, this.loadGen, 2500)
    }

    // If playhead is still at 0 while PCR buffer starts far ahead, nudge before play
    // (same condition mpegts StartupStallJumper fixes asynchronously).
    if (this.usingMpegts) {
      const bufStart = this.firstBufferedStart(v)
      if (bufStart != null && bufStart > 1 && v.currentTime < bufStart - 0.15) {
        try {
          v.currentTime = this.timeBase.isLocked
            ? this.timeBase.absoluteSec(this.pinnedRel ?? 0)
            : bufStart
        } catch {
          try {
            v.currentTime = bufStart
          } catch {
            /* ignore */
          }
        }
        await sleep(80)
      }
    }

    const tryPlay = async () => {
      if (this.player) {
        await Promise.race([
          Promise.resolve(this.player.play()).then(() => undefined),
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('play-timeout')), 3500)),
        ])
      } else {
        await Promise.race([
          v.play(),
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('play-timeout')), 3500)),
        ])
      }
      if (v.paused) {
        await v.play().catch(() => {})
      }
    }

    try {
      await tryPlay()
    } catch (err) {
      if (isNoSourceError(err) && this.lastLoadOpts) {
        const offset = this.pinnedRel ?? this.relativeSec
        await this.load({ ...this.lastLoadOpts, startOffsetSec: offset > 0.05 ? offset : 0 })
        try {
          await tryPlay()
        } catch {
          this.emit('buffering', false)
          return false
        }
      } else {
        const wasMuted = v.muted
        v.muted = true
        try {
          await tryPlay()
        } catch {
          v.muted = wasMuted
          this.emit('buffering', false)
          return false
        }
      }
    }

    if (v.paused) {
      this.emit('buffering', false)
      return false
    }

    // currentTime can advance from audio alone — require real painted frames.
    const framesOk = await this.waitForVideoFrames(2, 1400)
    if (!framesOk && this.lastLoadOpts) {
      const offset = this.pinnedRel ?? this.relativeSec
      await this.load({ ...this.lastLoadOpts, startOffsetSec: offset > 0.05 ? offset : 0 })
      try {
        await tryPlay()
      } catch {
        this.emit('buffering', false)
        return false
      }
      if (v.paused) {
        this.emit('buffering', false)
        return false
      }
      await this.waitForVideoFrames(2, 1400)
    }

    this.lastAbsMedia = v.currentTime
    this.lastAbsMediaAt = performance.now()
    this.armFrameWatch()
    this.emit('buffering', false)
    return !v.paused
  }

  pause() {
    this.cancelFrameWatch()
    try {
      this.player?.pause()
    } catch {
      /* ignore */
    }
    try {
      this.video?.pause()
    } catch {
      /* ignore */
    }
  }

  setPlaybackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate
  }

  setVolume(vol: number, muted: boolean) {
    const v = this.video
    if (!v) return
    v.muted = muted
    v.volume = muted ? 0 : Math.min(1, Math.max(0, vol))
  }

  unload() {
    this.loadGen += 1
    this.muteTime = true
    this.cancelFrameWatch()
    this.destroyPlayer({ clearVideo: true })
    this.timeBase.reset()
    this.url = ''
    this.fileName = ''
    this.lastLoadOpts = null
    this.muteTime = false
    this.emit('buffering', false)
  }

  /** @returns true when media has usable data */
  private async loadMpegts(url: string, gen: number): Promise<boolean> {
    const v = this.video
    if (!v) return false
    const features = mpegts.getFeatureList?.() ?? { mseLivePlayback: false }
    if (!mpegts.isSupported?.() && !features.mseLivePlayback) {
      this.emit('error', '当前环境不支持 MPEG-TS 流式回放')
      return false
    }

    try {
      v.removeAttribute('src')
    } catch {
      /* ignore */
    }

    this.player = mpegts.createPlayer(
      {
        type: 'mpegts',
        isLive: false,
        url,
        hasAudio: true,
        hasVideo: true,
        cors: true,
      },
      {
        enableStashBuffer: true,
        stashInitialSize: 512,
        lazyLoad: false,
        deferLoadAfterSourceOpen: false,
        seekType: 'range',
        accurateSeek: false,
        // CCTV TS often has audio DTS gaps; filling them keeps A/V from desyncing
        // into "clock runs / first video frame frozen".
        fixAudioTimestampGap: true,
      },
    ) as MpegtsPlayer

    this.player.attachMediaElement(v)
    this.player.load()
    this.player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
      if (gen !== this.loadGen) return
      const detail = formatMpegtsErrArgs(args)
      if (isMpegtsMseError(args)) {
        if (this.mseRecovering) {
          this.emit('buffering', false)
          return
        }
        this.mseRecovering = true
        // Rebuild once at pinned/requested offset — do not soft-jump on the broken session.
        const offset = this.pinnedRel ?? this.lastLoadOpts?.startOffsetSec ?? 0
        void this.reloadMpegtsAt(Math.max(0, offset))
          .catch(() => {})
          .finally(() => {
            this.mseRecovering = false
          })
        return
      }
      this.emit(
        'error',
        detail.toLowerCase().includes('network')
          ? '回放网络错误（请确认录像文件可读）'
          : `MPEG-TS 流式回放失败：${detail.slice(0, 160) || '编码可能不受支持'}`,
      )
      this.emit('buffering', false)
    })

    return this.waitForMpegtsReady(v, gen, 10000)
  }

  private async loadNative(url: string, gen: number) {
    const v = this.video
    if (!v) return
    v.src = url
    try {
      v.load()
    } catch {
      /* ignore */
    }
    await this.waitForReady(v, gen, 5000)
  }

  /**
   * Resolves true if readyState is usable; false on timeout / cancel with still-empty media.
   *
   * Important: mpegts MEDIA_INFO often fires after PAT/PMT/codec probe while the
   * video element is still readyState=0. Treating that as failure made rapid scrub
   * report "加载超时" even though the TS had already been fetched.
   */
  private waitForMpegtsReady(v: HTMLVideoElement, gen: number, timeoutMs: number): Promise<boolean> {
    if (gen !== this.loadGen) return Promise.resolve(false)
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve(true)

    // play() / load() overlap — join the in-flight wait instead of cancelling it as failure.
    if (this.readyWait && this.readyWait.gen === gen) {
      return this.readyWait.promise
    }

    this.readyWait?.cancel()
    this.readyWait = null

    let settle!: (ok: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve
    })

    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      v.removeEventListener('loadeddata', onReady)
      v.removeEventListener('canplay', onReady)
      if (this.readyWait?.promise === promise) this.readyWait = null
      settle(ok)
    }
    // Only succeed from media events — never finish(false) here (MEDIA_INFO race).
    const onReady = () => {
      if (v.readyState >= HTMLMediaElement.HAVE_METADATA) finish(true)
    }
    const timer = window.setTimeout(() => {
      finish(v.readyState >= HTMLMediaElement.HAVE_METADATA)
    }, timeoutMs)

    this.readyWait = { cancel: () => finish(false), promise, gen }
    v.addEventListener('loadeddata', onReady)
    v.addEventListener('canplay', onReady)

    const p = this.player
    if (p) {
      try {
        p.on(mpegts.Events.MEDIA_INFO, onReady)
      } catch {
        /* ignore */
      }
    }

    return promise
  }

  private waitForReady(v: HTMLVideoElement, gen: number, timeoutMs: number): Promise<void> {
    this.readyWait?.cancel()
    this.readyWait = null
    if (gen !== this.loadGen) return Promise.resolve()
    if (v.readyState >= 2) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        v.removeEventListener('loadeddata', onReady)
        v.removeEventListener('canplay', onReady)
        if (this.readyWait?.gen === gen) this.readyWait = null
        resolve()
      }
      const onReady = () => finish()
      const timer = window.setTimeout(finish, timeoutMs)
      // Native waits are not piggybacked by mpegts play(); slot is only for cancel.
      this.readyWait = { cancel: finish, promise: Promise.resolve(false), gen }
      v.addEventListener('loadeddata', onReady)
      v.addEventListener('canplay', onReady)
    })
  }

  private destroyPlayer(opts?: { clearVideo?: boolean }) {
    this.readyWait?.cancel()
    this.readyWait = null
    this.clearSeekedListeners()
    this.cancelFrameWatch()
    const v = this.video
    if (v) {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
    }
    if (this.player) {
      const p = this.player
      this.player = null
      try {
        p.pause()
      } catch {
        /* ignore */
      }
      try {
        p.unload()
      } catch {
        /* ignore */
      }
      try {
        p.detachMediaElement()
      } catch {
        /* ignore */
      }
      try {
        p.destroy()
      } catch {
        /* ignore */
      }
    }
    if (opts?.clearVideo && v) {
      try {
        v.removeAttribute('src')
      } catch {
        /* ignore */
      }
      // Intentionally do NOT call v.load() — it races with the next attachMediaElement
    }
  }

  private clearSeekedListeners() {
    const v = this.video
    if (v && this.seekedHandler) v.removeEventListener('seeked', this.seekedHandler)
    this.seekedHandler = null
    if (this.seekFallbackTimer) {
      clearTimeout(this.seekFallbackTimer)
      this.seekFallbackTimer = null
    }
    if (this.unpinTimer) {
      clearTimeout(this.unpinTimer)
      this.unpinTimer = null
    }
  }

  private syncMediaDuration() {
    const v = this.video
    if (!v) return
    const d = v.duration
    if (Number.isFinite(d) && d > 0.5 && d < 48 * 3600) this.mediaDurationSec = d
  }

  private onTimeUpdate = () => {
    if (!this.active || this.muteTime || this.seeking || this.pinnedRel != null) return
    const v = this.video
    if (!v) return
    this.syncMediaDuration()
    const abs = v.currentTime
    const now = performance.now()
    if (Number.isFinite(abs) && Math.abs(abs - this.lastAbsMedia) > 0.04) {
      this.lastAbsMedia = abs
      this.lastAbsMediaAt = now
    } else if (
      !v.paused &&
      this.hasSource &&
      this.usingMpegts &&
      this.lastAbsMediaAt > 0 &&
      now - this.lastAbsMediaAt > 2000 &&
      now - this.stallRecoverAt > 6000
    ) {
      this.stallRecoverAt = now
      const rel = this.timeBase.relativeSec(abs)
      void this.reloadMpegtsAt(rel).then(() => this.play())
      return
    }

    // Clock/progress advancing but no painted frames (frozen first frame).
    if (
      !v.paused &&
      this.usingMpegts &&
      this.hasSource &&
      this.lastFrameAt > 0 &&
      now - this.lastFrameAt > 1800 &&
      now - this.frameFrozenRecoverAt > 5000
    ) {
      this.frameFrozenRecoverAt = now
      const rel = this.timeBase.relativeSec(abs)
      void this.reloadMpegtsAt(rel).then(() => this.play())
      return
    }

    this.emit('time', this.timeBase.relativeSec(abs))
  }

  private onPlaying = () => {
    if (!this.active) return
    this.armFrameWatch()
    this.emit('buffering', false)
  }
  private onEnded = () => {
    if (!this.active) return
    this.cancelFrameWatch()
    this.emit('ended')
  }
  private onVideoError = () => {
    if (!this.active) return
    if (this.usingMpegts && this.player) return
    const err = this.video?.error
    this.emit('error', err?.message || '视频加载失败')
    this.emit('buffering', false)
  }

  /** Watch decoded video frames — independent of audio-driven currentTime. */
  private armFrameWatch() {
    this.cancelFrameWatch()
    const v = this.video as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number
        })
      | null
    if (!v) return
    if (typeof v.requestVideoFrameCallback !== 'function') {
      // No rVFC — seed so freeze detector does not fire spuriously
      this.lastFrameAt = performance.now()
      return
    }
    const loop = () => {
      this.lastFrameAt = performance.now()
      if (!this.active || !this.video || this.video.paused || !this.player) {
        this.frameWatchHandle = null
        return
      }
      this.frameWatchHandle = v.requestVideoFrameCallback!(loop)
    }
    this.frameWatchHandle = v.requestVideoFrameCallback(loop)
  }

  private cancelFrameWatch() {
    const v = this.video as
      | (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void })
      | null
    if (v && this.frameWatchHandle != null && typeof v.cancelVideoFrameCallback === 'function') {
      try {
        v.cancelVideoFrameCallback(this.frameWatchHandle)
      } catch {
        /* ignore */
      }
    }
    this.frameWatchHandle = null
  }

  /** Resolve true once `count` video frames have been painted (or timeout). */
  private waitForVideoFrames(count: number, timeoutMs: number): Promise<boolean> {
    const v = this.video as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number
          cancelVideoFrameCallback?: (h: number) => void
        })
      | null
    if (!v) return Promise.resolve(false)
    if (typeof v.requestVideoFrameCallback !== 'function') {
      return sleep(Math.min(400, timeoutMs)).then(() => !v.paused)
    }

    return new Promise((resolve) => {
      let got = 0
      let handle = 0
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        try {
          v.cancelVideoFrameCallback?.(handle)
        } catch {
          /* ignore */
        }
        if (ok) this.armFrameWatch()
        resolve(ok)
      }
      const timer = window.setTimeout(() => finish(got >= count), timeoutMs)
      const onFrame = () => {
        got += 1
        this.lastFrameAt = performance.now()
        if (got >= count) {
          finish(true)
          return
        }
        handle = v.requestVideoFrameCallback!(onFrame)
      }
      handle = v.requestVideoFrameCallback(onFrame)
    })
  }

  private emit<K extends keyof StreamEngineEvents>(event: K, ...args: Parameters<StreamEngineEvents[K]>) {
    if (!this.active && (event === 'time' || event === 'buffering' || event === 'ended')) return
    const fn = this.listeners[event]
    if (fn) (fn as (...a: unknown[]) => void)(...args)
  }
}
