<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Hls from 'hls.js'

const props = defineProps<{
  src: string | null
  muted?: boolean
  volume?: number
  mirrored?: boolean
  paused?: boolean
  isLive?: boolean
}>()

defineExpose({ captureFrame, playLocal, pauseLocal })

const videoRef = ref<HTMLVideoElement | null>(null)
const fault = ref('')
let hls: Hls | null = null
let attached = ''

function prefersNativeHls(video: HTMLVideoElement): boolean {
  const ua = navigator.userAgent
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/i.test(ua)
  return safari && video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

function destroy() {
  fault.value = ''
  attached = ''
  if (hls) {
    try {
      hls.destroy()
    } catch {
      /* ignore */
    }
    hls = null
  }
  const v = videoRef.value
  if (!v) return
  try {
    v.pause()
  } catch {
    /* ignore */
  }
  v.removeAttribute('src')
  v.srcObject = null
  try {
    v.load()
  } catch {
    /* ignore */
  }
}

function applyAudio() {
  const v = videoRef.value
  if (!v) return
  v.muted = props.muted !== false
  const vol = props.volume
  if (typeof vol === 'number' && Number.isFinite(vol)) {
    v.volume = Math.min(1, Math.max(0, vol))
  }
}

function attach(src: string | null) {
  const v = videoRef.value
  if (!v) return
  if (!src) {
    destroy()
    return
  }
  if (src === attached && (hls || v.src)) return
  destroy()
  attached = src
  applyAudio()
  if (prefersNativeHls(v)) {
    v.src = src
    void v.play().catch(() => undefined)
    return
  }
  if (!Hls.isSupported()) {
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src
      void v.play().catch(() => undefined)
      return
    }
    fault.value = '当前浏览器无法播放 HLS'
    return
  }
  const player = new Hls({
    enableWorker: true,
    capLevelToPlayerSize: true,
    lowLatencyMode: false,
    liveSyncDurationCount: 2,
    liveMaxLatencyDurationCount: 6,
    maxBufferLength: 8,
    maxMaxBufferLength: 12,
    liveBackBufferLength: 0,
    backBufferLength: 0,
    manifestLoadingMaxRetry: 4,
    levelLoadingMaxRetry: 2,
    fragLoadingMaxRetry: 1,
  })
  hls = player
  let jumped = 0
  player.on(Hls.Events.ERROR, (_evt, data) => {
    const missing =
      data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
      data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
    if (missing) {
      const now = Date.now()
      if (now-jumped > 1500) {
        jumped = now
        player.startLoad(-1)
      }
      return
    }
    if (!data.fatal) return
    const detail = String(data.details || data.type || '')
    if (/codec|bufferAdd|manifestIncompatible/i.test(detail)) {
      fault.value = '编码不受支持（请使用 H.264 子码流）'
      destroy()
      return
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      player.startLoad()
      return
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      player.recoverMediaError()
      return
    }
    fault.value = '预览中断'
    destroy()
  })
  player.loadSource(src)
  player.attachMedia(v)
  player.on(Hls.Events.MANIFEST_PARSED, () => {
    if (props.paused) return
    void v.play().catch(() => undefined)
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
  void videoRef.value?.play().catch(() => undefined)
}

function pauseLocal() {
  videoRef.value?.pause()
}

onMounted(() => attach(props.src))
onBeforeUnmount(() => destroy())
watch(() => props.src, (src) => attach(src))
watch(() => [props.muted, props.volume] as const, () => applyAudio())
watch(
  () => props.paused,
  (paused) => {
    if (paused) pauseLocal()
    else playLocal()
  },
)
</script>

<template>
  <div class="wrap" :class="{ mirrored }">
    <video ref="videoRef" class="player" :muted="muted !== false" playsinline autoplay />
    <p v-if="fault" class="fault">{{ fault }}</p>
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
  object-fit: contain;
  background: #0f161f;
}
.fault {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  margin: 0;
  color: #fecaca;
  font-size: 12px;
  text-align: center;
}
</style>
