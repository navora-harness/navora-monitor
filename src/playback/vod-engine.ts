/**
 * HLS VOD engine (hls.js) — windowed playlist, start-at-position, lean buffer.
 */

import Hls from 'hls.js'

export type VodEngineEvents = {
  ready: () => void
  time: (mediaSec: number, wallMs: number | null) => void
  ended: () => void
  error: (message: string) => void
  buffering: (on: boolean) => void
}

export class VodEngine {
  private video: HTMLVideoElement | null = null
  private hls: Hls | null = null
  private listeners: Partial<VodEngineEvents> = {}
  private loadGen = 0
  private seeking = false
  private pinnedMediaSec: number | null = null
  private windowStartMs: number | null = null
  private authToken: string | null = null
  private active = true
  private errorHandler: ((event: string, data: { fatal: boolean; type: string; details?: string }) => void) | null =
    null

  on<K extends keyof VodEngineEvents>(event: K, fn: VodEngineEvents[K]) {
    this.listeners[event] = fn as never
  }

  setActive(on: boolean) {
    this.active = on
  }

  setAuthToken(token: string | null) {
    this.authToken = token
  }

  attach(video: HTMLVideoElement) {
    this.video = video
    video.addEventListener('timeupdate', this.onTimeUpdate)
    video.addEventListener('seeking', this.onSeeking)
    video.addEventListener('seeked', this.onSeeked)
    video.addEventListener('playing', this.onPlaying)
    video.addEventListener('ended', this.onEnded)
    video.addEventListener('error', this.onVideoError)
  }

  detach() {
    const v = this.video
    if (v) {
      v.removeEventListener('timeupdate', this.onTimeUpdate)
      v.removeEventListener('seeking', this.onSeeking)
      v.removeEventListener('seeked', this.onSeeked)
      v.removeEventListener('playing', this.onPlaying)
      v.removeEventListener('ended', this.onEnded)
      v.removeEventListener('error', this.onVideoError)
    }
    this.destroyHls()
    this.video = null
  }

  get mediaSec(): number {
    if (this.pinnedMediaSec != null) return this.pinnedMediaSec
    const v = this.video
    if (!v || !Number.isFinite(v.currentTime)) return 0
    return Math.max(0, v.currentTime)
  }

  get durationSec(): number {
    const v = this.video
    const d = v?.duration
    if (d != null && Number.isFinite(d) && d > 0) return d
    return 0
  }

  get isSeeking(): boolean {
    return this.seeking
  }

  get paused(): boolean {
    return !!this.video?.paused
  }

  playingWallMs(): number | null {
    const hls = this.hls as Hls & { playingDate?: Date | null }
    const d = hls?.playingDate
    if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime()
    if (this.windowStartMs != null) {
      return this.windowStartMs + this.mediaSec * 1000
    }
    return null
  }

  /**
   * Load VOD m3u8 and buffer at startMediaSec (not from 0 — avoids downloading
   * the whole window into MSE before play).
   */
  async load(opts: { url: string; windowStartMs: number; startMediaSec?: number }) {
    const v = this.video
    if (!v) return
    const gen = ++this.loadGen
    this.destroyHls()
    this.windowStartMs = opts.windowStartMs
    this.seeking = false
    this.pinnedMediaSec = null
    this.emit('buffering', true)

    const startMediaSec = Math.max(0, opts.startMediaSec ?? 0)

    if (Hls.isSupported()) {
      await this.loadWithHls(opts.url, gen, startMediaSec)
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      await this.loadNativeHls(opts.url, gen, startMediaSec)
    } else {
      this.emit('error', '当前环境不支持 HLS 回放')
      this.emit('buffering', false)
    }
  }

  async seek(mediaSec: number) {
    const v = this.video
    if (!v) return
    const t = Math.max(0, mediaSec)
    this.seeking = true
    this.pinnedMediaSec = t
    this.emit('buffering', true)
    this.emitTime(t)

    // Prefer hls.js startLoad at target so it does not keep buffering from 0
    if (this.hls) {
      try {
        this.hls.startLoad(t)
      } catch {
        /* ignore */
      }
    }
    try {
      v.currentTime = t
    } catch {
      /* ignore */
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        v.removeEventListener('seeked', done)
        v.removeEventListener('canplay', done)
        window.clearTimeout(timer)
        resolve()
      }
      v.addEventListener('seeked', done)
      v.addEventListener('canplay', done)
      const timer = window.setTimeout(done, 2500)
    })

    this.seeking = false
    this.pinnedMediaSec = null
    this.emitTime(v.currentTime)
    await this.waitUntilPlayable(2800)
    this.emit('buffering', false)
  }

  /** Start playback; waits briefly for MSE data. Returns whether media is running. */
  async play(): Promise<boolean> {
    const v = this.video
    if (!v) return false

    await this.waitUntilPlayable(2000)

    const tryPlay = async () => {
      await Promise.race([
        v.play(),
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('play-timeout')), 3000)),
      ])
    }

    try {
      await tryPlay()
    } catch {
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

    if (v.paused) {
      try {
        await v.play()
      } catch {
        /* ignore */
      }
    }

    // Confirm we actually advanced (MSE can "play" while stuck)
    if (!v.paused) {
      const t0 = v.currentTime
      await new Promise((r) => setTimeout(r, 200))
      if (!v.paused && v.currentTime <= t0 + 0.01 && v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        // Stuck — treat as failure so controller can fall back to stream
        try {
          v.pause()
        } catch {
          /* ignore */
        }
        this.emit('buffering', false)
        return false
      }
    }

    this.emit('buffering', false)
    return !v.paused
  }

  pause() {
    this.video?.pause()
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
    this.destroyHls()
    const v = this.video
    if (v) {
      try {
        v.pause()
      } catch {
        /* ignore */
      }
      try {
        v.removeAttribute('src')
      } catch {
        /* ignore */
      }
      // Do NOT call v.load() — it clears MediaSource and races with mpegts attach
    }
    this.windowStartMs = null
    this.pinnedMediaSec = null
    this.seeking = false
    this.emit('buffering', false)
  }

  private async loadWithHls(url: string, gen: number, startMediaSec: number) {
    const v = this.video
    if (!v) return
    const token = this.authToken

    // Large CCTV .ts files are often ONE HLS fragment each — keep buffer lean
    // or MSE will download many multi‑MB segments without ever playing.
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: 18,
      maxMaxBufferLength: 36,
      maxBufferSize: 32 * 1000 * 1000,
      maxBufferHole: 1.5,
      startFragPrefetch: false,
      autoStartLoad: true,
      startPosition: startMediaSec > 0.25 ? startMediaSec : -1,
      xhrSetup: token
        ? (xhr) => {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          }
        : undefined,
    })
    this.hls = hls

    this.errorHandler = (_e, data) => {
      if (gen !== this.loadGen) return
      if (!data.fatal) {
        if (data.type === 'mediaError') {
          try {
            hls.recoverMediaError()
          } catch {
            /* ignore */
          }
        }
        return
      }
      const detail = data.details || data.type || 'hls error'
      this.emit('error', `HLS 回放失败：${String(detail).slice(0, 120)}`)
      this.emit('buffering', false)
      try {
        hls.destroy()
      } catch {
        /* ignore */
      }
      if (this.hls === hls) this.hls = null
    }
    hls.on(Hls.Events.ERROR, this.errorHandler as never)

    await new Promise<void>((resolve) => {
      const onAttached = () => {
        hls.off(Hls.Events.MEDIA_ATTACHED, onAttached)
        resolve()
      }
      hls.on(Hls.Events.MEDIA_ATTACHED, onAttached)
      hls.attachMedia(v)
      window.setTimeout(resolve, 2000)
    })
    if (gen !== this.loadGen) return

    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        hls.off(Hls.Events.MANIFEST_PARSED, onParsed)
        hls.off(Hls.Events.FRAG_BUFFERED, onFrag)
        resolve()
      }
      const onParsed = () => {
        if (gen !== this.loadGen) {
          finish()
          return
        }
        if (startMediaSec > 0.25) {
          try {
            hls.startLoad(startMediaSec)
            v.currentTime = startMediaSec
          } catch {
            /* ignore */
          }
        }
      }
      const onFrag = () => {
        if (gen !== this.loadGen) {
          finish()
          return
        }
        this.emit('ready')
        finish()
      }
      hls.on(Hls.Events.MANIFEST_PARSED, onParsed)
      hls.on(Hls.Events.FRAG_BUFFERED, onFrag)
      hls.loadSource(url)
      window.setTimeout(() => {
        if (gen === this.loadGen) this.emit('ready')
        finish()
      }, 8000)
    })

    if (gen !== this.loadGen) return
    await this.waitUntilPlayable(4000)
    this.emit('buffering', false)
  }

  private async loadNativeHls(url: string, gen: number, startMediaSec: number) {
    const v = this.video
    if (!v) return
    v.src = url
    await new Promise<void>((resolve) => {
      const done = () => {
        v.removeEventListener('loadedmetadata', done)
        resolve()
      }
      v.addEventListener('loadedmetadata', done)
      window.setTimeout(done, 5000)
    })
    if (gen !== this.loadGen) return
    if (startMediaSec > 0.25) {
      try {
        v.currentTime = startMediaSec
      } catch {
        /* ignore */
      }
    }
    await this.waitUntilPlayable(4000)
    this.emit('ready')
    this.emit('buffering', false)
  }

  private waitUntilPlayable(timeoutMs: number): Promise<void> {
    const v = this.video
    if (!v) return Promise.resolve()
    if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve()
    if ((v.buffered?.length ?? 0) > 0) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        v.removeEventListener('canplay', finish)
        v.removeEventListener('loadeddata', finish)
        window.clearTimeout(timer)
        resolve()
      }
      v.addEventListener('canplay', finish)
      v.addEventListener('loadeddata', finish)
      const timer = window.setTimeout(finish, timeoutMs)
    })
  }

  private destroyHls() {
    if (this.hls) {
      if (this.errorHandler) {
        try {
          this.hls.off(Hls.Events.ERROR, this.errorHandler)
        } catch {
          /* ignore */
        }
      }
      try {
        this.hls.destroy()
      } catch {
        /* ignore */
      }
      this.hls = null
    }
    this.errorHandler = null
  }

  private emitTime(mediaSec: number) {
    const wall = this.playingWallMs()
    const wallOut =
      wall ??
      (this.windowStartMs != null ? this.windowStartMs + mediaSec * 1000 : null)
    this.emit('time', mediaSec, wallOut)
  }

  private onTimeUpdate = () => {
    if (!this.active || this.seeking || this.pinnedMediaSec != null) return
    const v = this.video
    if (!v) return
    this.emitTime(v.currentTime)
  }

  private onSeeking = () => {
    if (!this.active) return
    this.seeking = true
  }

  private onSeeked = () => {
    if (!this.active) return
    this.seeking = false
    this.pinnedMediaSec = null
    const v = this.video
    if (v) this.emitTime(v.currentTime)
    this.emit('buffering', false)
  }

  private onPlaying = () => {
    if (!this.active) return
    this.emit('buffering', false)
  }

  private onEnded = () => {
    if (!this.active) return
    this.emit('ended')
  }

  private onVideoError = () => {
    if (!this.active || this.hls) return
    this.emit('error', this.video?.error?.message || '视频加载失败')
    this.emit('buffering', false)
  }

  private emit<K extends keyof VodEngineEvents>(
    event: K,
    ...args: Parameters<VodEngineEvents[K]>
  ) {
    if (!this.active && (event === 'time' || event === 'buffering' || event === 'ended')) return
    const fn = this.listeners[event]
    if (fn) (fn as (...a: unknown[]) => void)(...args)
  }
}
