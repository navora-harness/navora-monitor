<script setup lang="ts">
import { computed } from 'vue'
import type { ChannelConfig } from '@shared/types'
import MpegtsPlayer from '../components/MpegtsPlayer.vue'
import { buildRemoteLivePreviewUrl } from '../media-url'

const props = defineProps<{
  mosaic: 1 | 4 | 9 | 16
  channels: ChannelConfig[]
  slotIds: (string | null)[]
  selectedId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
}>()

const cols = computed(() => Math.round(Math.sqrt(props.mosaic)))

const cells = computed(() => {
  const out: Array<{ index: number; id: string | null; name: string; src: string | null }> = []
  for (let i = 0; i < props.mosaic; i++) {
    const id = props.slotIds[i] ?? null
    const ch = id ? props.channels.find((c) => c.id === id) : null
    const src = id ? buildRemoteLivePreviewUrl(id) : null
    out.push({
      index: i,
      id,
      name: ch?.name ?? (id ? id : `空位 ${i + 1}`),
      src,
    })
  }
  return out
})
</script>

<template>
  <div class="grid" :style="{ '--cols': cols }">
    <div
      v-for="cell in cells"
      :key="cell.index"
      class="cell"
      :class="{ active: cell.id && selectedId === cell.id, empty: !cell.id }"
      @click="cell.id && emit('select', cell.id)"
    >
      <div class="osd">{{ cell.name }}</div>
      <MpegtsPlayer v-if="cell.src" :key="cell.src" :src="cell.src" :muted="true" />
      <div v-else class="ph">{{ cell.id ? '无预览地址' : '空位' }}</div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 2), 1fr);
  grid-auto-rows: 1fr;
  gap: 2px;
  width: 100%;
  height: 100%;
  min-height: 200px;
  background: #0a0e14;
}
.cell {
  position: relative;
  min-height: 120px;
  overflow: hidden;
  background: #121820;
  outline: 1px solid transparent;
}
.cell.active {
  outline-color: #3b82f6;
}
.cell.empty {
  opacity: 0.7;
}
.osd {
  position: absolute;
  z-index: 2;
  left: 8px;
  top: 8px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #e8eef7;
  font-size: 12px;
  pointer-events: none;
}
.ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8b9bb0;
  font-size: 13px;
}
</style>
