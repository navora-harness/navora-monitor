<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import mpegts from 'mpegts.js'
import { isHevcMseError } from '@shared/hevc-mse'

type LivePlayer = {
  attachMediaElement: (el: HTMLMediaElement) => void
  detachMediaElement: () => void
  load: () => void
  unload: () => void
  play: () => Promise<void>
  pause: () => void
  destroy: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
}

const props = defineProps<{
  src: string | null
  muted?: boolean
  volume?: number
  mirrored?: boolean
  paused?: boolean
  /** Live low-latency vs VOD (recording playback). Default true. */
  isLive?: boolean
}>()

const emit = defineEmits<{
  hevcUnsupported: []
}>()

defineExpose({
  captureFrame,
  playLocal,
  pauseLocal,
})

const videoRef = ref<HTMLVideoElement | null>(null)
let player: LivePlayer | null = null
/** Prevent error-auto-reconnect while tearing down (avoids UI freeze). */
let destroying = false
let attachGen = 0
/** Last URL successfully handed to mpegts (skip no-op reattach on poll). */
let attachedAbs: string | null = null
let errorTimer: ReturnType<typeof setTimeout> | null = null
let errorBackoffMs = 800

function toAbsoluteUrl(src: string): string {
  try {
    return new URL(src, typeof location !== 'undefined' ? location.href : 'http://127.0.0.1').href
  } catch {
    return src
  }
}

function clearErrorTimer() {
  if (errorTimer) {
    clearTimeout(errorTimer)
    errorTimer = null
  }
}

function destroy() {
  destroying = true
  attachGen += 1
  clearErrorTimer()
  attachedAbs = null
  const p = player
  player = null
  const v = videoRef.value
  if (v) {
    try {
      v.pause()
    } catch {
      /* ignore */
    }
    try {
      v.removeAttribute('src')
      v.srcObject = null
      v.load()
    } catch {
      /* ignore */
    }
  }
  // Detach MSE off the click stack so rapid cell removes don't freeze the UI.
  if (p) {
    queueMicrotask(() => {
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
    })
  }
}

function applyAudio() {
  const v = videoRef.value
  if (!v) return
  v.muted = props.muted !== false
  const vol = typeof props.volume === 'number' ? props.volume : 0.8
  v.volume = Math.min(1, Math.max(0, vol))
}

function applyPaused() {
  const v = videoRef.value
  if (!v) return
  if (props.paused) {
    try {
      player?.pause()
    } catch {
      /* ignore */
    }
    v.pause()
  } else {
    void (player?.play() ?? v.play()).catch(() => undefined)
  }
}

function attach(src: string | null) {
  if (!src) {
    destroy()
    destroying = false
    return
  }

  const abs = toAbsoluteUrl(src)
  // Polling /api/previews rewrites the same absolute URL — do not tear down MSE.
  if (player && attachedAbs === abs && !destroying) {
    applyAudio()
    applyPaused()
    return
  }

  destroy()
  destroying = false
  const gen = ++attachGen
  const wanted = src

  void nextTick(() => {
    if (destroying || gen !== attachGen || props.src !== wanted) return
    const v = videoRef.value
    if (!v) {
      console.warn('[mpegts] video element missing, retry')
      setTimeout(() => {
        if (!destroying && props.src === wanted) attach(wanted)
      }, 50)
      return
    }

    applyAudio()

    if (!mpegts.isSupported() || !mpegts.getFeatureList().mseLivePlayback) {
      console.error('[mpegts] MSE live playback not supported in this browser')
      return
    }

    const live = props.isLive !== false
    try {
      // Preview ffmpeg uses `-an` (video-only). hasAudio:true stalls forever.
      player = mpegts.createPlayer(
        {
          type: 'mpegts',
          isLive: live,
          url: abs,
          hasAudio: false,
          hasVideo: true,
          cors: true,
          withCredentials: true,
        },
        live
          ? {
              enableWorker: false,
              enableStashBuffer: false,
              stashInitialSize: 128,
              liveBufferLatencyChasing: true,
              liveBufferLatencyMaxLatency: 1.5,
              liveBufferLatencyMinRemain: 0.3,
              lazyLoad: false,
              deferLoadAfterSourceOpen: false,
              autoCleanupSourceBuffer: true,
            }
          : {
              enableWorker: false,
              enableStashBuffer: true,
              stashInitialSize: 384,
              lazyLoad: false,
              deferLoadAfterSourceOpen: false,
              seekType: 'range',
            },
      ) as LivePlayer
      player.attachMediaElement(v)
      player.load()
      attachedAbs = abs
      errorBackoffMs = 800
      if (!props.paused) void player.play().catch(() => undefined)

      player.on(mpegts.Events.ERROR, (...args: unknown[]) => {
        if (!live || destroying) return
        if (isHevcMseError(...args)) {
          emit('hevcUnsupported')
          return
        }
        const url = props.src
        clearErrorTimer()
        const delay = errorBackoffMs
        errorBackoffMs = Math.min(8_000, Math.round(errorBackoffMs * 1.6))
        errorTimer = setTimeout(() => {
          errorTimer = null
          if (destroying || props.src !== url) return
          attachedAbs = null
          attach(url)
        }, delay)
      })
    } catch (err) {
      console.error('[mpegts] createPlayer/load failed', err)
      attachedAbs = null
    }
  })
}

function captureFrame(): string | null {
  const v = videoRef.value
  if (!v || v.videoWidth <= 0 || v.videoHeight <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = v.videoWidth
  canvas.height = v.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  if (props.mirrored) {
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
  }
  ctx.drawImage(v, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.92)
}

function playLocal() {
  void (player?.play() ?? videoRef.value?.play())?.catch(() => undefined)
}

function pauseLocal() {
  try {
    player?.pause()
  } catch {
    /* ignore */
  }
  videoRef.value?.pause()
}

onMounted(() => attach(props.src))
watch(
  () => props.src,
  (src) => attach(src),
)
watch(
  () => [props.muted, props.volume] as const,
  () => applyAudio(),
)
watch(
  () => props.paused,
  () => applyPaused(),
)
onBeforeUnmount(destroy)
</script>

<template>
  <div class="wrap" :class="{ mirrored }">
    <video ref="videoRef" class="player" :muted="muted !== false" playsinline autoplay />
  </div>
</template>

<style scoped>
.wrap {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0f161f;
}
.wrap.mirrored .player {
  transform: scaleX(-1);
}
.player {
  display: block;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background: #0f161f;
}
</style>
