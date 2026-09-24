/**
 * Windowed HLS VOD playback controller — wall-clock scrub / follow SSOT.
 * Finished .ts segments play via mpegts.js over localhost HTTP Range.
 */

import type { RecordingSegment } from '@shared/types'
import {
  defaultVodWindow,
  isFragileTsSegment,
  isHlsFriendlyTsSegment,
  mediaSecFromWallMs,
  wallMsFromPlaylistMediaTime,
  type VodSeg,
} from '@shared/vod-playlist'
import { isSegmentWriting } from '@shared/segment-writing'
import { StreamEngine } from './stream-engine'
import { VodEngine } from './vod-engine'
import { buildVodPlaylistUrl, withVodAuth, type VodSource } from './vod-url'
import {
  nextClip,
  segEndMs,
  segStartMs,
  segmentSpanSec,
  toTimedClip,
  wallToClip,
  isMpegTsPath,
} from './wall-time'
import { forceHttpMediaUrl } from '@shared/media-http-url'

export type PlaybackControllerEvents = {
  follow: (wallMs: number) => void
  segment: (seg: RecordingSegment | null) => void
  playing: (on: boolean) => void
  buffering: (on: boolean) => void
  error: (message: string) => void
  relativeTime: (sec: number, durationSec: number) => void
  playlistEnded: () => void
  /** True while playhead sits on a segment still being written. */
  liveRecording: (on: boolean) => void
  /** Short status for UI / debug (e.g. remux progress). */
  status: (message: string) => void
}

const HALF_WINDOW_MS = 20 * 60_000
/** Reload playlist when scrub leaves this inset of the window. */
const WINDOW_EDGE_MS = 60_000

type PlayMode = 'vod' | 'stream'

function segmentIsFragile(seg: RecordingSegment): boolean {
  return isFragileTsSegment({
    startMs: segStartMs(seg),
    endMs: segEndMs(seg),
    sizeBytes: seg.sizeBytes,
  })
}

export class PlaybackController {
  private vod = new VodEngine()
  private stream = new StreamEngine()
  private mode: PlayMode = 'vod'
  private segments: RecordingSegment[] = []
  private vodSegs: VodSeg[] = []
  private channelId: string | null = null
  private source: VodSource = 'loop'
  private sampleMediaUrl: string | null = null
  private mediaBaseUrl: string | null = null
  private authToken: string | null = null

  private windowStartMs = 0
  private windowEndMs = 0
  private windowLoaded = false
  private current: RecordingSegment | null = null
  private wantPlay = false
  private rate = 1
  private suspended = false
  private attached = false
  private listeners: Partial<PlaybackControllerEvents> = {}

  private pendingScrubMs: number | null = null
  private scrubTimer: ReturnType<typeof setTimeout> | null = null
  private scrubBusy = false
  private pinnedFollowWall: number | null = null
  private pinReleaseTimer: ReturnType<typeof setTimeout> | null = null
  private lastFollowEmitMs = 0
  private pendingFollowMs: number | null = null
  private followTimer: ReturnType<typeof setTimeout> | null = null
  private loadToken = 0
  private streamSegId: string | null = null
  private liveRecording = false
  /** Actual media loaded into StreamEngine (may be remuxed .play.mp4). */
  private streamPlayFile: string | null = null
  private streamPlayUrl: string | null = null
  private streamViaRemux = false

  /** Current engine: mpegts Range stream vs HLS VOD window. */
  get playMode(): PlayMode {
    return this.mode
  }

  /** True when stream mode is serving FFmpeg fMP4 remux (or legacy disk remux). */
  get viaRemux(): boolean {
    return this.mode === 'stream' && this.streamViaRemux
  }

  /** File name currently fed to the media element (after remux if any). */
  get playFileName(): string | null {
    return this.mode === 'stream' ? this.streamPlayFile : this.current?.fileName ?? null
  }

  /** URL currently fed to the media element (after remux if any). */
  get playUrl(): string | null {
    return this.mode === 'stream' ? this.streamPlayUrl : null
  }

  on<K extends keyof PlaybackControllerEvents>(event: K, fn: PlaybackControllerEvents[K]) {
    this.listeners[event] = fn as never
  }

  attach(video: HTMLVideoElement) {
    this.vod.attach(video)
    this.stream.attach(video)
    this.vod.setActive(true)
    this.stream.setActive(false)
    this.attached = true

    this.vod.on('time', (mediaSec, wallHint) => {
      if (this.mode !== 'vod') return
      this.emit('relativeTime', mediaSec, this.vod.durationSec)
      const wall =
        wallHint ??
        wallMsFromPlaylistMediaTime(this.hlsSegsInWindow(), mediaSec) ??
        this.windowStartMs + mediaSec * 1000
      this.handleWallTick(wall)
    })
    this.vod.on('ended', () => {
      if (this.mode !== 'vod') return
      this.emit('playing', false)
      this.emit('playlistEnded')
    })
    this.vod.on('error', (msg) => {
      if (this.mode !== 'vod') return
      void this.fallbackStreamFromVodError(msg)
    })
    this.vod.on('buffering', (on) => {
      if (this.mode !== 'vod') return
      this.emit('buffering', on)
    })
    this.vod.on('ready', () => {
      if (this.mode !== 'vod') return
      this.emit('buffering', false)
    })

    this.stream.on('time', (relSec) => {
      if (this.mode !== 'stream') return
      this.emit('relativeTime', relSec, this.stream.durationSec)
      const seg = this.current
      if (!seg) return
      const wall = segStartMs(seg) + relSec * 1000
      this.handleWallTick(wall)
    })
    this.stream.on('ended', () => {
      if (this.mode !== 'stream') return
      void this.onStreamEnded()
    })
    this.stream.on('error', (msg) => {
      if (this.mode !== 'stream') return
      this.emit('error', msg)
    })
    this.stream.on('buffering', (on) => {
      if (this.mode !== 'stream') return
      this.emit('buffering', on)
    })
    this.stream.on('ready', () => {
      if (this.mode !== 'stream') return
      this.emit('buffering', false)
    })
  }

  private useMode(next: PlayMode) {
    this.mode = next
    this.vod.setActive(next === 'vod')
    this.stream.setActive(next === 'stream')
  }

  private async ensurePlaying() {
    if (!this.wantPlay || this.suspended || this.liveRecording) {
      this.emit('playing', false)
      this.emit('buffering', false)
      return
    }
    this.emit('buffering', true)
    let ok = false
    let delegated = false
    try {
      ok = this.mode === 'stream' ? await this.stream.play() : await this.vod.play()
      if (!ok && this.wantPlay && !this.suspended && !this.liveRecording) {
        await new Promise((r) => setTimeout(r, 150))
        ok = this.mode === 'stream' ? await this.stream.play() : await this.vod.play()
      }
      // HLS buffered TS but never advanced — fall back to single-file mpegts
      if (!ok && this.mode === 'vod' && this.wantPlay && !this.suspended) {
        const wall =
          this.pinnedFollowWall ??
          wallMsFromPlaylistMediaTime(this.hlsSegsInWindow(), this.vod.mediaSec) ??
          null
        const seg = this.current ?? (wall != null ? this.segmentAtWall(wall) : null)
        if (seg) {
          const offset =
            wall != null ? Math.max(0, (wall - segStartMs(seg)) / 1000) : 0
          delegated = true
          await this.enterStreamMode(seg, offset)
          return
        }
      }
      this.emit('playing', ok)
    } finally {
      if (!delegated) this.emit('buffering', false)
    }
  }

  detach() {
    if (this.scrubTimer) clearTimeout(this.scrubTimer)
    if (this.followTimer) clearTimeout(this.followTimer)
    if (this.pinReleaseTimer) clearTimeout(this.pinReleaseTimer)
    this.scrubTimer = null
    this.followTimer = null
    this.pinReleaseTimer = null
    this.pendingScrubMs = null
    this.pinnedFollowWall = null
    this.vod.detach()
    this.stream.detach()
    this.attached = false
  }

  setChannelContext(opts: {
    channelId: string | null
    source?: VodSource
    sampleMediaUrl?: string | null
    /** http://127.0.0.1:port — rewrite navora:// media to HTTP Range */
    mediaBaseUrl?: string | null
    authToken?: string | null
  }) {
    const nextId = opts.channelId
    const nextSource = opts.source === 'saved' ? 'saved' : 'loop'
    const changed = nextId !== this.channelId || nextSource !== this.source
    this.channelId = nextId
    this.source = nextSource
    if (opts.sampleMediaUrl != null) this.sampleMediaUrl = opts.sampleMediaUrl
    if (opts.mediaBaseUrl !== undefined) this.mediaBaseUrl = opts.mediaBaseUrl
    if (opts.authToken !== undefined) {
      this.authToken = opts.authToken
      this.vod.setAuthToken(opts.authToken)
    }
    if (changed) {
      this.windowLoaded = false
    }
  }

  setSegments(segments: RecordingSegment[]) {
    this.segments = segments
    this.vodSegs = segments
      .filter((s) => s.fileName.toLowerCase().endsWith('.ts'))
      .map((s) => {
        const c = toTimedClip(s)
        return {
          fileName: s.fileName,
          startMs: c.startMs,
          endMs: c.endMs,
          sizeBytes: s.sizeBytes,
        }
      })
      .sort((a, b) => a.startMs - b.startMs)
    if (!this.sampleMediaUrl) {
      const u = segments.find((s) => s.url)?.url
      if (u) this.sampleMediaUrl = u
    }
  }

  setContinuous(_on: boolean) {
    /* continuous is inherent to HLS VOD window; stream mode chains via ended */
  }

  setRate(rate: number) {
    this.rate = rate
    this.vod.setPlaybackRate(rate)
    this.stream.setPlaybackRate(rate)
  }

  setSuspended(on: boolean) {
    this.suspended = on
    if (on) {
      this.vod.pause()
      this.stream.pause()
      this.emit('playing', false)
    } else if (this.wantPlay && this.pinnedFollowWall == null) {
      void this.ensurePlaying()
    }
  }

  setVolume(vol: number, muted: boolean) {
    this.vod.setVolume(vol, muted)
    this.stream.setVolume(vol, muted)
  }

  getCurrentSegment(): RecordingSegment | null {
    return this.current
  }

  scrubToWall(wallMs: number) {
    if (!this.attached) return
    this.pendingScrubMs = wallMs
    this.pinnedFollowWall = wallMs
    this.emitFollow(wallMs, true)
    // Do not pause mpegts here — pause+seek on CCTV TS triggers MediaMSEError.
    // flushScrub will replace/seek the engine.
    if (this.scrubTimer) clearTimeout(this.scrubTimer)
    this.scrubTimer = setTimeout(() => {
      this.scrubTimer = null
      void this.flushScrub()
    }, 160)
  }

  async playSegment(seg: RecordingSegment, offsetSec = 0) {
    this.wantPlay = true
    this.pendingScrubMs = null
    const wall = segStartMs(seg) + offsetSec * 1000
    this.pinnedFollowWall = wall
    this.emitFollow(wall, true)
    await this.ensureWindowAndSeek(wall)
  }

  async play() {
    if (this.liveRecording) return
    this.wantPlay = true
    if (this.mode === 'stream' && this.current) {
      if (this.suspended) return
      // Source may have been torn down — reload then play
      if (!this.stream.hasSource) {
        const wall = this.pinnedFollowWall ?? segStartMs(this.current)
        const offset = Math.max(0, (wall - segStartMs(this.current)) / 1000)
        await this.enterStreamMode(this.current, offset)
        this.settleFollowToMedia(wall)
        return
      }
      await this.ensurePlaying()
      return
    }
    if (!this.windowLoaded) {
      const first = this.segments[0]
      if (first) await this.playSegment(first, 0)
      return
    }
    if (!this.suspended) await this.ensurePlaying()
  }

  pause() {
    this.wantPlay = false
    this.vod.pause()
    this.stream.pause()
    this.emit('playing', false)
  }

  async skipRelative(deltaSec: number) {
    const wall =
      this.pinnedFollowWall ??
      (this.mode === 'stream' && this.current
        ? segStartMs(this.current) + this.stream.relativeSec * 1000
        : wallMsFromPlaylistMediaTime(this.hlsSegsInWindow(), this.vod.mediaSec)) ??
      Date.now()
    this.scrubToWall(wall + deltaSec * 1000)
  }

  stop() {
    this.wantPlay = false
    this.pendingScrubMs = null
    this.clearFollowPin()
    this.windowLoaded = false
    this.current = null
    this.streamSegId = null
    this.streamPlayFile = null
    this.streamPlayUrl = null
    this.streamViaRemux = false
    this.useMode('vod')
    this.setLiveRecording(false)
    this.vod.unload()
    this.stream.unload()
    this.emit('segment', null)
    this.emit('playing', false)
    this.emit('buffering', false)
  }

  private handleWallTick(wall: number) {
    if (this.pinnedFollowWall != null) {
      // Only release pin when media actually reached the scrub target.
      if (Math.abs(wall - this.pinnedFollowWall) < 2000) {
        this.clearFollowPin()
        this.emitFollow(wall, true)
        this.syncCurrentSegment(wall)
        return
      }
      this.emitFollow(this.pinnedFollowWall, true)
      return
    }
    this.emitFollow(wall, false)
    this.syncCurrentSegment(wall)
  }

  /** Pin timeline to scrub target until media catches up — no timed bounce. */
  private holdFollowPin(wallMs: number) {
    this.pinnedFollowWall = wallMs
    this.emitFollow(wallMs, true)
    if (this.pinReleaseTimer) {
      clearTimeout(this.pinReleaseTimer)
      this.pinReleaseTimer = null
    }
  }

  private clearFollowPin() {
    this.pinnedFollowWall = null
    if (this.pinReleaseTimer) {
      clearTimeout(this.pinReleaseTimer)
      this.pinReleaseTimer = null
    }
  }

  /**
   * After load/seek, snap follow to wherever the decoder actually landed
   * (kills "progress at scrub target / picture at file start").
   */
  private settleFollowToMedia(requestedWallMs: number) {
    if (this.mode === 'stream' && this.current) {
      const landed = segStartMs(this.current) + this.stream.relativeSec * 1000
      this.clearFollowPin()
      this.emitFollow(landed, true)
      this.syncCurrentSegment(landed)
      return
    }
    if (this.mode === 'vod') {
      const wall =
        wallMsFromPlaylistMediaTime(this.hlsSegsInWindow(), this.vod.mediaSec) ?? requestedWallMs
      this.clearFollowPin()
      this.emitFollow(wall, true)
      this.syncCurrentSegment(wall)
      return
    }
    this.clearFollowPin()
    this.emitFollow(requestedWallMs, true)
  }

  private async flushScrub() {
    if (this.scrubBusy) return
    this.scrubBusy = true
    try {
      while (this.pendingScrubMs != null && this.attached) {
        const wall = this.pendingScrubMs
        this.pendingScrubMs = null
        await this.ensureWindowAndSeek(wall)
      }
    } finally {
      this.scrubBusy = false
      if (this.pendingScrubMs != null && !this.scrubTimer) {
        this.scrubTimer = setTimeout(() => {
          this.scrubTimer = null
          void this.flushScrub()
        }, 40)
      }
    }
  }

  private setLiveRecording(on: boolean) {
    if (this.liveRecording === on) return
    this.liveRecording = on
    this.emit('liveRecording', on)
  }

  private async showLiveRecording(seg: RecordingSegment, wallMs: number) {
    this.loadToken += 1
    this.useMode('vod')
    this.windowLoaded = false
    this.streamSegId = null
    this.vod.unload()
    this.stream.unload()
    this.wantPlay = false
    this.current = seg
    this.emit('segment', seg)
    this.emit('playing', false)
    this.emit('buffering', false)
    this.setLiveRecording(true)
    this.holdFollowPin(wallMs)
  }

  private async ensureWindowAndSeek(wallMs: number) {
    const clips = this.segments.map(toTimedClip).sort((a, b) => a.startMs - b.startMs)
    const hit = wallToClip(clips, wallMs)

    let mediaWall = wallMs
    let offsetSec = 0
    let targetSeg: RecordingSegment | null = null

    if (hit.kind === 'gap') {
      mediaWall = hit.nearest.startMs + hit.offsetSec * 1000
      offsetSec = hit.offsetSec
      targetSeg = this.segments.find((s) => s.id === hit.nearest.id) ?? null
    } else if (hit.kind === 'empty') {
      this.vod.unload()
      this.stream.unload()
      this.windowLoaded = false
      this.streamSegId = null
      this.useMode('vod')
      this.setLiveRecording(false)
      this.current = null
      this.emit('segment', null)
      this.holdFollowPin(wallMs)
      return
    } else {
      mediaWall = hit.clip.startMs + hit.offsetSec * 1000
      offsetSec = hit.offsetSec
      targetSeg = this.segments.find((s) => s.id === hit.clip.id) ?? null
    }

    this.wantPlay = true
    this.holdFollowPin(wallMs)

    if (targetSeg && isSegmentWriting(targetSeg)) {
      await this.showLiveRecording(targetSeg, wallMs)
      return
    }

    this.setLiveRecording(false)

    // Prefer single-file mpegts.js. HLS VOD treats each multi‑MB .ts as one
    // fragment — it eagerly downloads many files into MSE and often never
    // reaches a playable state. Continuous play chains via stream `ended`.
    // Switch to stream before any segment emit so UI/debug never flashes [vod]→[stream].
    if (targetSeg) {
      await this.enterStreamMode(targetSeg, offsetSec)
      if (this.pendingScrubMs != null) return
      this.settleFollowToMedia(wallMs)
      return
    }

    this.syncCurrentSegment(mediaWall)
    await this.enterVodMode(mediaWall)
    if (this.pendingScrubMs != null) return
    this.settleFollowToMedia(wallMs)
  }

  /** HLS-friendly segments only — must match server m3u8 filter. */
  private hlsSegsInWindow(): VodSeg[] {
    return this.vodSegs.filter(
      (s) =>
        isHlsFriendlyTsSegment(s) &&
        s.endMs > this.windowStartMs &&
        s.startMs < this.windowEndMs,
    )
  }

  private async enterVodMode(mediaWall: number) {
    this.setLiveRecording(false)
    if (this.mode === 'stream') {
      this.stream.unload()
      this.streamSegId = null
    }
    this.useMode('vod')

    const needReload =
      !this.windowLoaded ||
      mediaWall < this.windowStartMs + WINDOW_EDGE_MS ||
      mediaWall > this.windowEndMs - WINDOW_EDGE_MS

    if (needReload) {
      await this.loadWindow(mediaWall)
      if (this.pendingScrubMs != null) return
      // loadWindow may have switched to stream fallback
      if (this.mode !== 'vod') return
      // loadWindow already started at mediaSec — skip second seek
      await this.ensurePlaying()
      return
    }

    const mediaSec = mediaSecFromWallMs(this.hlsSegsInWindow(), mediaWall) ?? 0
    await this.vod.seek(mediaSec)
    if (this.pendingScrubMs != null) return

    await this.ensurePlaying()
  }

  private async enterStreamMode(seg: RecordingSegment, offsetSec: number) {
    if (isSegmentWriting(seg)) {
      await this.showLiveRecording(seg, segStartMs(seg) + offsetSec * 1000)
      return
    }
    const token = ++this.loadToken
    this.setLiveRecording(false)
    this.vod.unload()
    const offset = Math.max(0, offsetSec)

    // Same recording file — rebuild/seek in place. Do not require hasSource:
    // mid-scrub readyState is often 0, and forcing load() stacking raced the MSE session.
    const sameFile =
      this.mode === 'stream' && this.streamSegId === seg.id && this.stream.hasSession
    this.useMode('stream')
    this.windowLoaded = false
    const segChanged = this.current?.id !== seg.id
    this.current = seg
    this.streamSegId = seg.id
    if (segChanged || !sameFile) this.emit('segment', seg)

    if (sameFile) {
      await this.stream.seek(offset)
      if (token !== this.loadToken || this.mode !== 'stream') return
      this.stream.setPlaybackRate(this.rate)
      await this.ensurePlaying()
      return
    }

    let url = seg.playbackUrl || seg.url
    if (!url) {
      this.emit('error', '录像地址无效')
      return
    }

    // Prefer localhost HTTP Range for mpegts.js (navora:// is Range-hostile).
    url = forceHttpMediaUrl(url, this.mediaBaseUrl || this.sampleMediaUrl)

    const playFileName = seg.fileName
    const transport = isMpegTsPath(seg.fileName) || isMpegTsPath(url) ? 'mpegts' : 'native'

    this.streamPlayFile = playFileName
    this.streamViaRemux = false

    url = withVodAuth(url, this.authToken)
    this.streamPlayUrl = url

    await this.stream.load({
      url,
      fileName: playFileName,
      wallSpanSec: segmentSpanSec(seg),
      startOffsetSec: offset,
      transport,
    })
    if (token !== this.loadToken || this.mode !== 'stream') return

    this.stream.setPlaybackRate(this.rate)
    await this.ensurePlaying()
  }

  private async fallbackStreamFromVodError(hlsMsg: string) {
    const wall =
      this.pinnedFollowWall ??
      wallMsFromPlaylistMediaTime(this.hlsSegsInWindow(), this.vod.mediaSec) ??
      null
    const seg =
      this.current ??
      (wall != null
        ? this.segments.find((s) => {
            const a = segStartMs(s)
            const b = segEndMs(s)
            return wall >= a && wall <= b
          })
        : null)
    if (!seg) {
      this.emit('error', hlsMsg)
      return
    }
    const offset =
      wall != null ? Math.max(0, (wall - segStartMs(seg)) / 1000) : 0
    try {
      await this.enterStreamMode(seg, offset)
    } catch {
      this.emit('error', hlsMsg)
    }
  }

  private async onStreamEnded() {
    this.emit('playing', false)
    const cur = this.current
    if (!cur) {
      this.emit('playlistEnded')
      return
    }
    const clips = this.segments.map(toTimedClip).sort((a, b) => a.startMs - b.startMs)
    const next = nextClip(clips, cur.id)
    if (!next) {
      this.emit('playlistEnded')
      return
    }
    // Continue into next clip (may switch back to VOD if friendly)
    this.wantPlay = true
    await this.ensureWindowAndSeek(next.startMs)
  }

  private async loadWindow(centerWallMs: number) {
    if (!this.channelId) {
      this.emit('error', '未选择通道')
      return
    }
    const token = ++this.loadToken
    const { startMs, endMs } = defaultVodWindow(centerWallMs, HALF_WINDOW_MS)
    let url = buildVodPlaylistUrl({
      channelId: this.channelId,
      startMs,
      endMs,
      source: this.source,
      sampleMediaUrl: this.sampleMediaUrl,
    })
    if (!url) {
      // No VOD host — fall back to single-file stream at this wall
      const seg = this.segmentAtWall(centerWallMs)
      if (seg) {
        const offset = Math.max(0, (centerWallMs - segStartMs(seg)) / 1000)
        await this.enterStreamMode(seg, offset)
      } else {
        this.emit('error', '无法构建回放地址')
      }
      return
    }
    url = withVodAuth(url, this.authToken)

    const friendly = this.vodSegs.filter(
      (s) => isHlsFriendlyTsSegment(s) && s.endMs > startMs && s.startMs < endMs,
    )
    if (!friendly.length) {
      const seg = this.segmentAtWall(centerWallMs)
      if (seg) {
        const offset = Math.max(0, (centerWallMs - segStartMs(seg)) / 1000)
        await this.enterStreamMode(seg, offset)
      } else {
        this.emit('error', '当前窗口没有可播放切片')
      }
      return
    }

    this.windowStartMs = friendly[0]!.startMs
    this.windowEndMs = friendly[friendly.length - 1]!.endMs

    this.setLiveRecording(false)
    this.stream.unload()
    this.streamSegId = null
    this.useMode('vod')

    const startMediaSec = mediaSecFromWallMs(friendly, centerWallMs) ?? 0
    await this.vod.load({
      url,
      windowStartMs: this.windowStartMs,
      startMediaSec,
    })
    if (token !== this.loadToken) return
    this.windowLoaded = true
    this.vod.setPlaybackRate(this.rate)
  }

  private segmentAtWall(wallMs: number): RecordingSegment | null {
    return (
      this.segments.find((s) => {
        const a = segStartMs(s)
        const b = segEndMs(s)
        return wallMs >= a && wallMs <= b
      }) ?? null
    )
  }

  private syncCurrentSegment(wallMs: number) {
    const seg = this.segmentAtWall(wallMs)
    if (seg?.id !== this.current?.id) {
      this.current = seg
      this.emit('segment', seg)
    }
  }

  private emitFollow(wallMs: number, force: boolean) {
    if (force) {
      this.pendingFollowMs = null
      this.lastFollowEmitMs = performance.now()
      this.emit('follow', wallMs)
      return
    }
    const now = performance.now()
    if (now - this.lastFollowEmitMs >= 100) {
      this.lastFollowEmitMs = now
      this.pendingFollowMs = null
      this.emit('follow', wallMs)
      return
    }
    this.pendingFollowMs = wallMs
    if (this.followTimer) return
    this.followTimer = setTimeout(() => {
      this.followTimer = null
      if (this.pendingFollowMs == null) return
      this.lastFollowEmitMs = performance.now()
      this.emit('follow', this.pendingFollowMs)
      this.pendingFollowMs = null
    }, 100)
  }

  private emit<K extends keyof PlaybackControllerEvents>(
    event: K,
    ...args: Parameters<PlaybackControllerEvents[K]>
  ) {
    const fn = this.listeners[event]
    if (fn) (fn as (...a: unknown[]) => void)(...args)
  }
}
