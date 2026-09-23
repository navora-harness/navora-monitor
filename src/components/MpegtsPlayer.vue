<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import mpegts from 'mpegts.js'

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
}>()

defineExpose({
  captureFrame,
  playLocal,
  pauseLocal,
})

const videoRef = ref<HTMLVideoElement | null>(null)
let player: LivePlayer | null = null

function destroy() {
  if (player) {
    try {
      player.pause()
      player.unload()
      player.detachMediaElement()
      player.destroy()
    } catch {
      /* ignore */
    }
    player = null
  }
  const v = videoRef.value
  if (v) {
    v.removeAttribute('src')
    v.load()
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
  destroy()
  const v = videoRef.value
  if (!v || !src) return

  applyAudio()

  if (!mpegts.getFeatureList().mseLivePlayback) {
    v.src = src
    if (!props.paused) void v.play().catch(() => undefined)
    return
  }

  player = mpegts.createPlayer(
    {
      type: 'mpegts',
      isLive: true,
      url: src,
      hasAudio: true,
      hasVideo: true,
    },
    {
      enableStashBuffer: false,
      stashInitialSize: 128,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      lazyLoad: false,
      deferLoadAfterSourceOpen: false,
    },
  ) as LivePlayer
  player.attachMediaElement(v)
  player.load()
  if (!props.paused) void player.play().catch(() => undefined)

  player.on(mpegts.Events.ERROR, () => {
    const url = props.src
    setTimeout(() => {
      if (props.src === url) attach(url)
    }, 800)
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
