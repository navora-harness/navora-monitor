<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { RecordingSegment } from '@shared/types'

const props = defineProps<{
  channelName: string | null
  segment: RecordingSegment | null
  rate: number
  /** Pause playback when main window is hidden. */
  suspended?: boolean
}>()

const emit = defineEmits<{
  exit: []
  ended: []
  'update:rate': [rate: number]
}>()

const videoRef = ref<HTMLVideoElement | null>(null)

const title = computed(() => {
  if (!props.segment) return '回放'
  return props.segment.fileName
})

async function loadSegment(seg: RecordingSegment | null) {
  await nextTick()
  const v = videoRef.value
  if (!v) return
  if (!seg) {
    v.removeAttribute('src')
    v.load()
    return
  }
  v.src = seg.url
  v.playbackRate = props.rate
  if (props.suspended) {
    v.pause()
    return
  }
  try {
    await v.play()
  } catch {
    /* autoplay / codec */
  }
}

watch(
  () => props.segment,
  (seg) => {
    void loadSegment(seg)
  },
)

watch(
  () => props.rate,
  (r) => {
    if (videoRef.value) videoRef.value.playbackRate = r
  },
)

watch(
  () => props.suspended,
  (off) => {
    const v = videoRef.value
    if (!v) return
    if (off) v.pause()
    else if (props.segment) void v.play().catch(() => undefined)
  },
)

function onEnded() {
  emit('ended')
}
</script>

<template>
  <div class="playback">
    <div class="top">
      <div class="mode">
        <span class="pill">回放</span>
        <span class="ch">{{ channelName || '未选择通道' }}</span>
        <span v-if="segment" class="file" :title="title">
          <span v-if="segment.protected">★ </span>{{ title }}
        </span>
      </div>
      <button type="button" class="exit" @click="emit('exit')">返回实时</button>
    </div>

    <div class="stage">
      <video
        v-if="segment"
        ref="videoRef"
        class="video"
        controls
        playsinline
        @ended="onEnded"
      />
      <div v-else class="empty">
        <p>选择下方时间轴中的片段开始回放</p>
        <p class="hint">也可在实时预览工具栏点击「回放」进入</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.playback {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0f161f;
}
.top {
  flex-shrink: 0;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid rgb(255 255 255 / 10%);
  background: #121820;
  color: #e8edf2;
}
.mode {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.pill {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
}
.ch {
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 600;
}
.file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #9aa7b5;
}
.exit {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid rgb(255 255 255 / 16%);
  background: rgb(255 255 255 / 8%);
  color: #e8edf2;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.exit:hover {
  background: rgb(255 255 255 / 14%);
}
.stage {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.empty {
  text-align: center;
  color: #9aa7b5;
  font-size: 14px;
  padding: 24px;
}
.hint {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.7;
}
</style>
