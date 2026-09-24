<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RecordingSegment } from '@shared/types'
import { formatSegmentClock, formatSegmentTimeRange } from '@shared/segment-time'
import { isMpegTsPath } from '../playback/wall-time'
import { PlaybackController } from '../playback/playback-controller'

const RATES = [0.5, 1, 1.5, 2, 4] as const

const props = withDefaults(
  defineProps<{
    channelName: string | null
    channelId?: string | null
    /** loop | saved — VOD source */
    source?: 'loop' | 'saved'
    /** Ordered segments (timeline blocks + VOD index hints) */
    playlist: RecordingSegment[]
    rate: number
    continuous?: boolean
    scrubWallMs?: number | null
    scrubNonce?: number
    playId?: string | null
    playNonce?: number
    suspended?: boolean
    /** Remote auth token for HLS segment fetches */
    authToken?: string | null
    /** Local media HTTP origin, e.g. http://127.0.0.1:19200 */
    mediaBaseUrl?: string | null
  }>(),
  {
    channelId: null,
    source: 'loop',
    continuous: true,
    scrubWallMs: null,
    scrubNonce: 0,
    playId: null,
    playNonce: 0,
    suspended: false,
    authToken: null,
    mediaBaseUrl: null,
  },
)

const emit = defineEmits<{
  exit: []
  'update:rate': [rate: number]
  follow: [wallMs: number]
  segment: [seg: RecordingSegment | null]
  playlistEnded: []
  /** True while media is buffering / seeking — parent should lock timeline drag */
  busy: [on: boolean]
}>()

const rootRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const playError = ref('')
const playing = ref(false)
const muted = ref(false)
const volume = ref(0.85)
const currentSec = ref(0)
const durationSec = ref(0)
const buffering = ref(false)
const chromeVisible = ref(true)
const scrubbing = ref(false)
const scrubPreview = ref(0)
const fullscreen = ref(false)
const showDebug = ref(false)
const loadPhase = ref('idle')
const debugLines = ref<string[]>([])
const segment = ref<RecordingSegment | null>(null)
/** Single wall-clock source for on-screen clock (same as timeline follow). */
const wallNowMs = ref<number | null>(null)
const liveRecording = ref(false)
const playMode = ref<'vod' | 'stream'>('vod')
const viaRemux = ref(false)
const statusHint = ref('')
const playMediaName = ref('')
const playMediaUrl = ref('')

const controller = new PlaybackController()
let hideTimer: ReturnType<typeof setTimeout> | null = null
let scrubWallMsPreview: number | null = null
let timeRaf = 0
let pendingRelSec = 0
let pendingDurSec = 0
let wallRaf = 0
let pendingWallMs: number | null = null
/** Clear stuck spinner if media is ready but still marked buffering. */
let bufferingWatch: ReturnType<typeof setTimeout> | null = null
let playKickInFlight = false

function clearBufferingWatch() {
  if (bufferingWatch) {
    clearTimeout(bufferingWatch)
    bufferingWatch = null
  }
}

function armBufferingWatch() {
  clearBufferingWatch()
  bufferingWatch = setTimeout(() => {
    bufferingWatch = null
    if (!buffering.value || liveRecording.value || !segment.value) return
    const v = videoRef.value
    const ready = v != null && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    pushDebug(
      `buffering-watch readyState=${v?.readyState ?? -1} paused=${v?.paused ?? '?'} playing=${playing.value} mode=${playMode.value}`,
    )
    if (ready && v && v.paused && !playing.value && !playKickInFlight) {
      // Media has data but play never stuck — one kickoff, keep spinner until playing event
      playKickInFlight = true
      void controller
        .play()
        .then(() => {
          if (!playing.value) buffering.value = false
        })
        .catch(() => {
          buffering.value = false
        })
        .finally(() => {
          playKickInFlight = false
        })
    } else if (!ready) {
      // Still no data after wait — drop spinner so user can tap play
      buffering.value = false
      loadPhase.value = 'ready'
    }
  }, 3500)
}

function pushDebug(msg: string) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`
  debugLines.value = [...debugLines.value.slice(-40), line]
  console.info('[playback]', msg)
}

const title = computed(() => {
  if (!segment.value) return '回放'
  return formatSegmentTimeRange(segment.value.startMs, segment.value.endMs)
})

const dayLabel = computed(() => {
  const ms = segment.value?.startMs ?? segment.value?.mtimeMs
  if (ms == null) return ''
  return new Date(ms).toLocaleDateString()
})

const isTs = computed(() => {
  const name = segment.value?.fileName ?? ''
  const url = segment.value?.url ?? ''
  return isMpegTsPath(name) || isMpegTsPath(url)
})

const engineLabel = computed(() => {
  if (playMode.value === 'stream') {
    return isTs.value ? 'mpegts HTTP Range' : 'progressive HTTP'
  }
  return isTs.value ? 'HLS VOD' : 'HLS / progressive'
})

const bufferingHint = computed(() => {
  if (statusHint.value) return statusHint.value
  return '加载中…'
})

function syncPlayMode() {
  playMode.value = controller.playMode
  viaRemux.value = controller.viaRemux
  playMediaName.value = controller.playFileName || playMediaName.value
  playMediaUrl.value = controller.playUrl || playMediaUrl.value
}

const effectiveDuration = computed(() => durationSec.value)

const progress = computed(() => {
  const dur = effectiveDuration.value
  if (!(dur > 0)) return 0
  const t = scrubbing.value ? scrubPreview.value : currentSec.value
  return Math.min(1, Math.max(0, t / dur))
})

const wallNowLabel = computed(() => {
  if (scrubbing.value && scrubWallMsPreview != null) {
    return formatSegmentClock(scrubWallMsPreview, true)
  }
  const ms = wallNowMs.value
  if (ms == null) return '—'
  return formatSegmentClock(ms, true)
})

const timeLeftLabel = computed(() => {
  const remain = Math.max(
    0,
    effectiveDuration.value - (scrubbing.value ? scrubPreview.value : currentSec.value),
  )
  return formatClock(remain)
})

const elapsedLabel = computed(() => formatClock(scrubbing.value ? scrubPreview.value : currentSec.value))

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const p = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${p(m)}:${p(r)}`
  return `${p(m)}:${p(r)}`
}

function bindController() {
  controller.on('follow', (wallMs) => {
    pendingWallMs = wallMs
    if (!wallRaf) {
      wallRaf = requestAnimationFrame(() => {
        wallRaf = 0
        if (pendingWallMs != null) wallNowMs.value = pendingWallMs
      })
    }
    emit('follow', wallMs)
  })
  controller.on('segment', (seg) => {
    segment.value = seg
    emit('segment', seg)
    syncPlayMode()
    if (!seg) {
      statusHint.value = ''
      playMediaName.value = ''
      playMediaUrl.value = ''
    }
    loadPhase.value = seg ? 'ready' : 'idle'
    if (!seg) {
      wallNowMs.value = null
      liveRecording.value = false
    }
    const remux = controller.viaRemux ? ' remux' : ''
    pushDebug(seg ? `segment ${seg.fileName} [${controller.playMode}${remux}]` : 'segment cleared')
  })
  controller.on('playing', (on) => {
    playing.value = on
    syncPlayMode()
    if (on) {
      buffering.value = false
      clearBufferingWatch()
      if (segment.value) loadPhase.value = 'playing'
      if (statusHint.value.startsWith('转封装') || statusHint.value.includes('fMP4') || statusHint.value.includes('缓存')) {
        statusHint.value = ''
      }
    }
    emit('busy', buffering.value)
  })
  controller.on('buffering', (on) => {
    buffering.value = on
    syncPlayMode()
    emit('busy', on)
    if (on) {
      loadPhase.value = 'buffering'
      armBufferingWatch()
      // Cancel in-progress progress-bar drag
      if (scrubbing.value) {
        scrubbing.value = false
        scrubWallMsPreview = null
      }
    } else {
      clearBufferingWatch()
      if (segment.value) {
        loadPhase.value = playing.value ? 'playing' : 'ready'
      } else {
        loadPhase.value = 'idle'
      }
    }
  })
  controller.on('error', (msg) => {
    playError.value = msg
    pushDebug(`error: ${msg}`)
  })
  controller.on('relativeTime', (sec, dur) => {
    pendingRelSec = sec
    pendingDurSec = dur
    if (timeRaf) return
    timeRaf = requestAnimationFrame(() => {
      timeRaf = 0
      if (!scrubbing.value) currentSec.value = pendingRelSec
      durationSec.value = pendingDurSec
    })
  })
  controller.on('playlistEnded', () => {
    playing.value = false
    emit('playlistEnded')
  })
  controller.on('liveRecording', (on) => {
    liveRecording.value = on
    if (on) {
      playError.value = ''
      buffering.value = false
      playing.value = false
      loadPhase.value = 'recording'
      pushDebug('live recording — unplayable until finalize')
    }
  })
  controller.on('status', (message) => {
    statusHint.value = message
    syncPlayMode()
    pushDebug(message)
  })
}

function togglePlay() {
  if (!segment.value || liveRecording.value) return
  if (playing.value) controller.pause()
  else void controller.play()
  bumpChrome()
}

function skipBy(delta: number) {
  void controller.skipRelative(delta)
  bumpChrome()
}

function setRate(r: number) {
  emit('update:rate', r)
  controller.setRate(r)
}

function toggleMute() {
  muted.value = !muted.value
  controller.setVolume(volume.value, muted.value)
}

function setVolume(v: number) {
  volume.value = Math.min(1, Math.max(0, v))
  if (volume.value > 0.02) muted.value = false
  controller.setVolume(volume.value, muted.value)
}

async function toggleFullscreen() {
  const el = rootRef.value
  if (!el) return
  try {
    if (!document.fullscreenElement) await el.requestFullscreen()
    else await document.exitFullscreen()
  } catch {
    /* ignore */
  }
}

function onFsChange() {
  fullscreen.value = !!document.fullscreenElement
}

function bumpChrome() {
  chromeVisible.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (playing.value && segment.value) chromeVisible.value = false
  }, 2800)
}

function onStageMove() {
  bumpChrome()
}

function ratioFromEvent(e: PointerEvent): number {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  if (!(rect.width > 0)) return 0
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
}

function onProgressDown(e: PointerEvent) {
  if (liveRecording.value || buffering.value) return
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  scrubbing.value = true
  const ratio = ratioFromEvent(e)
  scrubPreview.value = ratio * effectiveDuration.value
  const baseWall = (wallNowMs.value ?? 0) - currentSec.value * 1000
  scrubWallMsPreview = baseWall + scrubPreview.value * 1000
}

function onProgressMove(e: PointerEvent) {
  if (!scrubbing.value) return
  const ratio = ratioFromEvent(e)
  scrubPreview.value = ratio * effectiveDuration.value
  const baseWall = (wallNowMs.value ?? 0) - currentSec.value * 1000
  scrubWallMsPreview = baseWall + scrubPreview.value * 1000
}

function onProgressUp(e: PointerEvent) {
  if (!scrubbing.value) return
  scrubbing.value = false
  const ratio = ratioFromEvent(e)
  const sec = ratio * effectiveDuration.value
  scrubPreview.value = sec
  currentSec.value = sec
  const baseWall = (wallNowMs.value ?? 0) - (pendingRelSec || 0) * 1000
  const wall = baseWall + sec * 1000
  scrubWallMsPreview = null
  void controller.scrubToWall(wall)
  bumpChrome()
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault()
    togglePlay()
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    skipBy(e.shiftKey ? -10 : -5)
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    skipBy(e.shiftKey ? 10 : 5)
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    void toggleFullscreen()
  } else if (e.key === 'm' || e.key === 'M') {
    e.preventDefault()
    toggleMute()
  } else if (e.key === 'Escape' && !document.fullscreenElement) {
    emit('exit')
  }
}

watch(
  () => props.playlist,
  (list) => {
    controller.setSegments(list)
    controller.setChannelContext({
      channelId: props.channelId,
      source: props.source,
      sampleMediaUrl: list.find((s) => s.url)?.url ?? null,
      mediaBaseUrl: props.mediaBaseUrl,
      authToken: props.authToken,
    })
  },
  { immediate: true },
)

watch(
  () => [props.channelId, props.source, props.authToken, props.mediaBaseUrl] as const,
  () => {
    controller.setChannelContext({
      channelId: props.channelId,
      source: props.source,
      sampleMediaUrl: props.playlist.find((s) => s.url)?.url ?? null,
      mediaBaseUrl: props.mediaBaseUrl,
      authToken: props.authToken,
    })
  },
)

watch(
  () => props.continuous,
  (on) => controller.setContinuous(on !== false),
  { immediate: true },
)

watch(
  () => props.rate,
  (r) => controller.setRate(r),
  { immediate: true },
)

watch(
  () => props.suspended,
  (on) => controller.setSuspended(!!on),
  { immediate: true },
)

watch(
  () => [props.scrubWallMs, props.scrubNonce] as const,
  ([ms]) => {
    if (ms == null || !Number.isFinite(ms)) return
    playError.value = ''
    loadPhase.value = 'scrub'
    pushDebug(`scrub wall=${new Date(ms).toLocaleTimeString()}`)
    void controller.scrubToWall(ms)
  },
)

watch(
  () => [props.playId, props.playNonce] as const,
  ([id]) => {
    if (!id) return
    const seg = props.playlist.find((s) => s.id === id)
    if (!seg) return
    playError.value = ''
    loadPhase.value = 'load'
    pushDebug(`play ${seg.fileName}`)
    void controller.playSegment(seg, 0)
  },
)

onMounted(async () => {
  bindController()
  await nextTick()
  if (videoRef.value) {
    controller.attach(videoRef.value)
    controller.setVolume(volume.value, muted.value)
    controller.setRate(props.rate)
  }
  // Watches may have fired before attach — apply pending play/scrub once ready
  if (props.playId) {
    const seg = props.playlist.find((s) => s.id === props.playId)
    if (seg) void controller.playSegment(seg, 0)
  } else if (props.scrubWallMs != null && Number.isFinite(props.scrubWallMs)) {
    void controller.scrubToWall(props.scrubWallMs)
  }
  document.addEventListener('fullscreenchange', onFsChange)
  window.addEventListener('keydown', onKey)
  bumpChrome()
})

onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('keydown', onKey)
  if (hideTimer) clearTimeout(hideTimer)
  clearBufferingWatch()
  if (timeRaf) cancelAnimationFrame(timeRaf)
  if (wallRaf) cancelAnimationFrame(wallRaf)
  controller.stop()
  controller.detach()
})
</script>

<template>
  <div
    ref="rootRef"
    class="playback"
    :class="{ 'chrome-hidden': segment && !chromeVisible && playing }"
    @mousemove="onStageMove"
    @mouseleave="chromeVisible = true"
  >
    <header class="top" @mousemove.stop>
      <div class="mode">
        <span class="pill">回放</span>
        <span class="ch">{{ channelName || '未选择通道' }}</span>
        <span v-if="segment" class="file" :title="segment.fileName">
          <span v-if="segment.protected">★ </span>
          <span v-if="dayLabel">{{ dayLabel }} · </span>{{ title }}
          <span v-if="isTs" class="tag">TS</span>
        </span>
        <span v-else class="file muted">拖动时间轴中线定位回放</span>
      </div>
      <div class="top-actions">
        <button
          type="button"
          class="exit ghost"
          :class="{ on: showDebug }"
          title="加载调试"
          @click="showDebug = !showDebug"
        >
          调试
        </button>
        <button type="button" class="exit" @click="emit('exit')">返回实时</button>
      </div>
    </header>

    <div class="stage" @click="segment && !liveRecording ? togglePlay() : undefined">
      <video
        ref="videoRef"
        class="video"
        :class="{ idle: !segment || liveRecording }"
        playsinline
        preload="auto"
      />

      <div v-if="liveRecording" class="empty recording" @click.stop>
        <p class="rec-title">正在录制中</p>
        <p class="hint">该时段仍在写入，稍后再回放</p>
      </div>

      <div v-else-if="!segment" class="empty" @click.stop>
        <p>抓取滚动时间轴，中线对准要看的时刻</p>
        <p class="hint">有录像的色块滚到中线即开始播放</p>
      </div>

      <p v-if="playError && !liveRecording" class="err">{{ playError }}</p>

      <aside v-if="showDebug" class="debug" @click.stop>
        <div class="debug-head">
          <strong>回放加载状态</strong>
          <span class="phase">{{ loadPhase }}</span>
          <button type="button" class="debug-x" @click="showDebug = false">×</button>
        </div>
        <dl class="debug-meta">
          <div>
            <dt>文件</dt>
            <dd>{{ segment?.fileName || '—' }}</dd>
          </div>
          <div>
            <dt>播放介质</dt>
            <dd>{{ playMediaName || segment?.fileName || '—' }}</dd>
          </div>
          <div>
            <dt>源 URL</dt>
            <dd class="mono">{{ segment?.url || '—' }}</dd>
          </div>
          <div>
            <dt>实际播放 URL</dt>
            <dd class="mono">{{ playMediaUrl || '—' }}</dd>
          </div>
          <div>
            <dt>路径</dt>
            <dd>{{ engineLabel }}</dd>
          </div>
        </dl>
        <pre class="debug-log">{{ debugLines.length ? debugLines.join('\n') : '尚无日志' }}</pre>
      </aside>
    </div>

    <footer v-if="segment" class="bar" :class="{ recording: liveRecording }" @click.stop @mousemove.stop="bumpChrome">
      <div
        class="scrub"
        role="slider"
        :aria-valuemin="0"
        :aria-valuemax="Math.round(effectiveDuration)"
        :aria-valuenow="Math.round(scrubbing ? scrubPreview : currentSec)"
        :aria-label="`进度 ${wallNowLabel}`"
        :aria-disabled="liveRecording || buffering"
        :class="{ locked: buffering || liveRecording }"
        @pointerdown="liveRecording || buffering ? undefined : onProgressDown($event)"
        @pointermove="onProgressMove"
        @pointerup="onProgressUp"
        @pointercancel="onProgressUp"
      >
        <div class="scrub-track">
          <div class="scrub-fill" :style="{ width: `${progress * 100}%` }" />
          <div class="scrub-thumb" :style="{ left: `${progress * 100}%` }" />
        </div>
      </div>

      <div class="controls">
        <div class="left">
          <button
            type="button"
            class="icon play-toggle"
            :class="{ loading: buffering && !liveRecording }"
            :title="
              buffering && !liveRecording
                ? bufferingHint
                : playing
                  ? '暂停 (Space)'
                  : '播放 (Space)'
            "
            :aria-busy="buffering && !liveRecording ? 'true' : undefined"
            :disabled="liveRecording"
            @click="togglePlay"
          >
            <span
              v-if="buffering && !liveRecording"
              class="buf-spin"
              aria-hidden="true"
            />
            <svg v-else-if="!playing" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5L8 5.5Z" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
            </svg>
          </button>
          <button type="button" class="icon skip" title="后退 5 秒 (←)" @click="skipBy(-5)">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M11.2 6.2a7 7 0 1 0 6.3 4.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
              <path d="M11.2 3.6v4.8L7.4 6.2l3.8-2.6Z" fill="currentColor" />
              <text
                x="12.2"
                y="14.6"
                text-anchor="middle"
                fill="currentColor"
                font-size="7.5"
                font-weight="700"
                font-family="Segoe UI, system-ui, sans-serif"
              >
                5
              </text>
            </svg>
          </button>
          <button type="button" class="icon skip" title="前进 5 秒 (→)" @click="skipBy(5)">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12.8 6.2a7 7 0 1 1 -6.3 4.1"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
              />
              <path d="M12.8 3.6v4.8l3.8-2.2-3.8-2.6Z" fill="currentColor" />
              <text
                x="11.8"
                y="14.6"
                text-anchor="middle"
                fill="currentColor"
                font-size="7.5"
                font-weight="700"
                font-family="Segoe UI, system-ui, sans-serif"
              >
                5
              </text>
            </svg>
          </button>
          <div class="times">
            <span class="wall">{{ wallNowLabel }}</span>
            <span class="sep">·</span>
            <span class="rel">{{ elapsedLabel }} / {{ formatClock(effectiveDuration) }}</span>
            <span class="sep">·</span>
            <span class="left-t">−{{ timeLeftLabel }}</span>
          </div>
        </div>

        <div class="right">
          <div class="vol">
            <button type="button" class="icon" :title="muted ? '取消静音 (M)' : '静音 (M)'" @click="toggleMute">
              <svg v-if="muted || volume < 0.02" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 9h3.2L12 5v14l-4.8-4H4V9Zm11.2-.8 1.4 1.4 1.4-1.4.9.9-1.4 1.4 1.4 1.4-.9.9-1.4-1.4-1.4 1.4-.9-.9 1.4-1.4-1.4-1.4.9-.9Z"
                  fill="currentColor"
                />
              </svg>
              <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 9h3.2L12 5v14l-4.8-4H4V9Zm9.5-2a5 5 0 0 1 0 10l-1.1-1.2a3.4 3.4 0 0 0 0-7.6L13.5 7Zm2.6-2.2a8 8 0 0 1 0 14.4l-1.1-1.3a6.4 6.4 0 0 0 0-11.8l1.1-1.3Z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <input
              class="vol-range"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="Math.round((muted ? 0 : volume) * 100)"
              @input="setVolume(Number(($event.target as HTMLInputElement).value) / 100)"
              @click.stop
            />
          </div>

          <div class="rates" role="group" aria-label="倍速">
            <button
              v-for="r in RATES"
              :key="r"
              type="button"
              class="rate"
              :class="{ on: rate === r }"
              @click="setRate(r)"
            >
              {{ r }}×
            </button>
          </div>

          <button
            type="button"
            class="icon"
            :title="fullscreen ? '退出全屏 (F)' : '全屏 (F)'"
            @click="toggleFullscreen"
          >
            <svg v-if="!fullscreen" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9 9H5V5M15 9h4V5M9 15H5v4M15 15h4v4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </footer>
  </div>
</template>


<style scoped>
.playback {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0b1017;
  position: relative;
  outline: none;
}
.top {
  flex-shrink: 0;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid rgb(255 255 255 / 8%);
  background: linear-gradient(180deg, #161e2a, #121923);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.playback.chrome-hidden .top {
  opacity: 0;
  pointer-events: none;
  transform: translateY(-6px);
}
.mode {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: #e8edf3;
  font-size: 12px;
}
.pill {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 4px;
  background: #0d6b54;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.ch {
  font-weight: 600;
  white-space: nowrap;
}
.file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #9aa7b5;
  font-variant-numeric: tabular-nums;
}
.file.muted {
  opacity: 0.75;
}
.tag {
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgb(255 255 255 / 10%);
  font-size: 10px;
  font-weight: 700;
  color: #c5d0dc;
}
.exit {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  background: transparent;
  color: #e8edf3;
  cursor: pointer;
  font-size: 12px;
}
.exit:hover {
  background: rgb(255 255 255 / 8%);
}
.exit.ghost {
  border-color: transparent;
  color: #9aa7b5;
}
.exit.ghost.on {
  color: #3dba8f;
  background: rgb(61 186 143 / 14%);
  border-color: rgb(61 186 143 / 35%);
}
.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #05070b;
  cursor: pointer;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.video.idle {
  opacity: 0;
  pointer-events: none;
  position: absolute;
}
.empty {
  text-align: center;
  color: #9aa7b5;
  padding: 24px;
  pointer-events: none;
}
.empty.recording .rec-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: #d1d5db;
}
.empty p {
  margin: 0 0 6px;
  font-size: 14px;
}
.hint {
  font-size: 12px;
  opacity: 0.75;
}
.buf-spin {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 22%);
  border-top-color: #3dba8f;
  animation: spin 0.75s linear infinite;
  pointer-events: none;
}
.icon.play-toggle.loading {
  color: #3dba8f;
  cursor: default;
}
.icon.play-toggle.loading:hover {
  background: transparent;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.err {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 76px;
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgb(180 35 24 / 88%);
  color: #fff;
  font-size: 12px;
  pointer-events: none;
  z-index: 3;
}
.debug {
  position: absolute;
  left: 12px;
  top: 12px;
  width: min(420px, calc(100% - 24px));
  max-height: min(52%, 360px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgb(8 12 18 / 92%);
  border: 1px solid rgb(255 255 255 / 12%);
  color: #d5dee8;
  font-size: 11px;
  z-index: 5;
  box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
  pointer-events: auto;
}
.debug-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.debug-head strong {
  font-size: 12px;
  color: #fff;
}
.debug-head .phase {
  margin-right: auto;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgb(61 186 143 / 18%);
  color: #3dba8f;
  font-variant-numeric: tabular-nums;
}
.debug-x {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #9aa7b5;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.debug-x:hover {
  background: rgb(255 255 255 / 8%);
  color: #fff;
}
.debug-meta {
  margin: 0;
  display: grid;
  gap: 4px;
}
.debug-meta > div {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 8px;
}
.debug-meta dt {
  margin: 0;
  color: #7f8b9a;
}
.debug-meta dd {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.debug-meta .mono {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
}
.debug-log {
  margin: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  border-radius: 6px;
  background: rgb(0 0 0 / 35%);
  color: #b8c4d0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}
.bar {
  flex-shrink: 0;
  padding: 8px 12px 10px;
  background: linear-gradient(180deg, rgb(12 16 24 / 92%), #0e141d);
  border-top: 1px solid rgb(255 255 255 / 8%);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.playback.chrome-hidden .bar {
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px);
}
.scrub {
  height: 18px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
  margin-bottom: 6px;
}
.scrub.locked {
  cursor: wait;
  opacity: 0.55;
  pointer-events: none;
}
.bar.recording .scrub {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}
.scrub-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: rgb(255 255 255 / 14%);
  overflow: visible;
}
.scrub:hover .scrub-track {
  height: 6px;
}
.scrub-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, #0d6b54, #3dba8f);
}
.scrub-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgb(0 0 0 / 45%);
  opacity: 0;
  transition: opacity 0.12s ease;
}
.scrub:hover .scrub-thumb,
.scrub:active .scrub-thumb {
  opacity: 1;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.right {
  flex-shrink: 0;
  gap: 8px;
}
.icon {
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #e8edf3;
  display: grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.icon:hover {
  background: rgb(255 255 255 / 8%);
}
.icon svg {
  width: 18px;
  height: 18px;
  display: block;
}
.icon.skip svg {
  width: 20px;
  height: 20px;
}
.icon.skip text {
  pointer-events: none;
}
.times {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #9aa7b5;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
}
.times .wall {
  color: #e8edf3;
  font-weight: 650;
}
.times .sep {
  opacity: 0.45;
}
.vol {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.vol-range {
  width: 72px;
  accent-color: #3dba8f;
  cursor: pointer;
}
.rates {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: rgb(255 255 255 / 6%);
}
.rate {
  height: 26px;
  min-width: 36px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #9aa7b5;
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.rate.on {
  background: #0d6b54;
  color: #fff;
}
.rate:hover:not(.on) {
  color: #e8edf3;
}

@media (max-width: 900px) {
  .times .left-t,
  .times .sep:last-of-type {
    display: none;
  }
  .vol-range {
    width: 56px;
  }
}

@media (max-width: 640px) {
  .top {
    height: auto;
    min-height: 44px;
    padding: 8px 10px;
    padding-top: max(8px, env(safe-area-inset-top, 0px));
    flex-wrap: wrap;
    gap: 8px;
  }
  .mode {
    flex: 1 1 160px;
    gap: 8px;
  }
  .file {
    display: none;
  }
  .exit {
    height: 36px;
    padding: 0 14px;
  }
  .bar {
    padding: 10px 10px calc(10px + env(safe-area-inset-bottom, 0px));
  }
  .controls {
    flex-wrap: wrap;
    gap: 8px;
  }
  .left,
  .right {
    width: 100%;
    justify-content: space-between;
  }
  .icon {
    width: 42px;
    height: 42px;
  }
  .icon svg {
    width: 20px;
    height: 20px;
  }
  .icon.skip svg {
    width: 22px;
    height: 22px;
  }
  .times {
    margin-left: 0;
    font-size: 11px;
  }
  .vol-range {
    width: 88px;
    height: 36px;
  }
  .rates {
    flex: 1;
    justify-content: space-between;
  }
  .rate {
    flex: 1;
    height: 34px;
  }
  .err {
    bottom: 120px;
  }
}
</style>
