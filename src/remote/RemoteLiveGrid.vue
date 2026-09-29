<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ChannelConfig } from '@shared/types'
import MpegtsPlayer from '../components/MpegtsPlayer.vue'
import { buildRemoteLivePreviewUrl } from '../media-url'
import { pushEscapeLayer } from '../ui/escape-stack'

const props = defineProps<{
  mosaic: 1 | 4 | 9 | 16
  channels: ChannelConfig[]
  slotIds: (string | null)[]
  selectedId: string | null
  /** Phone / narrow viewport — larger hit targets, always-visible enlarge chrome */
  mobile?: boolean
  /** grid = classic mosaic; scroll = vertical stack (mobile) */
  layoutMode?: 'grid' | 'scroll'
}>()

const emit = defineEmits<{
  select: [id: string]
  enlarged: [index: number | null]
}>()

const enlargedIndex = ref<number | null>(null)
let lastTapAt = 0
let lastTapIndex = -1
let pendingSelectTimer: ReturnType<typeof setTimeout> | null = null
let escapeUnsub: (() => void) | null = null

const cols = computed(() => Math.round(Math.sqrt(props.mosaic)))
const scrollMode = computed(() => props.layoutMode === 'scroll')

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

const visibleCells = computed(() => {
  if (enlargedIndex.value != null) {
    const one = cells.value.find((c) => c.index === enlargedIndex.value && c.id)
    return one ? [one] : []
  }
  if (scrollMode.value) {
    const filled = cells.value.filter((c) => c.id)
    return filled.length ? filled : cells.value
  }
  return cells.value
})

const gridCols = computed(() => (enlargedIndex.value == null ? cols.value : 1))

const enlargedCell = computed(() => {
  if (enlargedIndex.value == null) return null
  return cells.value.find((c) => c.index === enlargedIndex.value) ?? null
})

function clearPendingSelect() {
  if (pendingSelectTimer) {
    clearTimeout(pendingSelectTimer)
    pendingSelectTimer = null
  }
}

function toggleEnlarge(index: number, id: string | null) {
  if (!id) return
  clearPendingSelect()
  lastTapAt = 0
  lastTapIndex = -1
  enlargedIndex.value = enlargedIndex.value === index ? null : index
  emit('select', id)
}

function exitEnlarge() {
  enlargedIndex.value = null
}

function onCellClick(cell: { index: number; id: string | null }) {
  if (!cell.id) return
  if (!props.mobile) {
    emit('select', cell.id)
    return
  }
  const now = Date.now()
  if (lastTapIndex === cell.index && now - lastTapAt < 320) {
    clearPendingSelect()
    toggleEnlarge(cell.index, cell.id)
    return
  }
  lastTapAt = now
  lastTapIndex = cell.index
  clearPendingSelect()
  // Defer select so a completing double-tap doesn't close the drawer / thrash state twice.
  const id = cell.id
  pendingSelectTimer = setTimeout(() => {
    pendingSelectTimer = null
    emit('select', id)
  }, 320)
}

watch(enlargedIndex, (index) => {
  emit('enlarged', index)
  escapeUnsub?.()
  escapeUnsub = null
  if (index != null) {
    escapeUnsub = pushEscapeLayer(() => {
      exitEnlarge()
    })
  }
})

watch(
  () => props.mosaic,
  () => {
    if (enlargedIndex.value != null) enlargedIndex.value = null
  },
)

watch(
  () => props.slotIds.slice(),
  (ids) => {
    const idx = enlargedIndex.value
    if (idx == null) return
    if (!ids[idx]) exitEnlarge()
  },
)

onUnmounted(() => {
  clearPendingSelect()
  escapeUnsub?.()
  escapeUnsub = null
})
</script>

<template>
  <div
    class="live-shell"
    :class="{
      mobile: !!mobile,
      enlarged: enlargedIndex != null,
      scroll: scrollMode && enlargedIndex == null,
    }"
  >
    <div v-if="enlargedIndex != null" class="enlarge-bar">
      <span class="enlarge-name">{{ enlargedCell?.name || '预览' }}</span>
      <button type="button" class="enlarge-exit" @click.stop="exitEnlarge">还原宫格</button>
    </div>
    <div
      class="grid"
      :class="{ enlarged: enlargedIndex != null, scroll: scrollMode && enlargedIndex == null }"
      :style="{ '--cols': gridCols }"
    >
      <div
        v-for="cell in visibleCells"
        :key="cell.index"
        class="cell"
        :class="{
          active: cell.id && selectedId === cell.id,
          empty: !cell.id,
          solo: enlargedIndex === cell.index,
        }"
        @click="onCellClick(cell)"
      >
        <div class="osd">
          <span class="osd-name">{{ cell.name }}</span>
          <button
            v-if="cell.id"
            type="button"
            class="osd-btn"
            :title="enlargedIndex === cell.index ? '还原宫格' : '放大（一路独占）'"
            :aria-label="enlargedIndex === cell.index ? '还原宫格' : '放大画面'"
            @click.stop="toggleEnlarge(cell.index, cell.id)"
          >
            <svg v-if="enlargedIndex === cell.index" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M6 3.5H3.5V6M10 3.5h2.5V6M6 12.5H3.5V10M10 12.5h2.5V10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
              />
            </svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.5 6V3.5H6M10 3.5h2.5V6M3.5 10v2.5H6M10 12.5h2.5V10"
                fill="none"
                stroke="currentColor"
                stroke-width="1.35"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
        <MpegtsPlayer v-if="cell.src" :key="cell.src" :src="cell.src" :muted="true" />
        <div v-else class="ph">{{ cell.id ? '无预览地址' : '空位' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.live-shell.scroll {
  min-height: 0;
  overflow: hidden;
}
.enlarge-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  padding-top: max(8px, env(safe-area-inset-top));
  background: color-mix(in srgb, var(--panel, #1a2230) 92%, #000);
  border-bottom: 1px solid rgb(255 255 255 / 10%);
  z-index: 3;
}
.enlarge-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #e8eef7);
}
.enlarge-exit {
  flex-shrink: 0;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid rgb(255 255 255 / 22%);
  background: rgb(59 130 246 / 28%);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.enlarge-exit:active {
  background: rgb(59 130 246 / 45%);
}
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--cols, 2), 1fr);
  grid-auto-rows: 1fr;
  gap: 2px;
  width: 100%;
  height: 100%;
  background: #0a0e14;
}
.grid.enlarged {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.grid.scroll {
  display: flex;
  flex-direction: column;
  grid-template-columns: none;
  grid-template-rows: none;
  gap: 10px;
  padding: 10px;
  overflow-x: hidden;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  height: 100%;
}
.grid.scroll .cell {
  flex: 0 0 auto;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  min-height: 160px;
  max-height: min(62vh, 420px);
  border-radius: 10px;
  border: 1px solid rgb(255 255 255 / 8%);
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
.cell.solo {
  min-height: 0;
  height: 100%;
}
.osd {
  position: absolute;
  z-index: 2;
  left: 8px;
  right: 8px;
  top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.osd-name {
  min-width: 0;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #e8eef7;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.osd-btn {
  pointer-events: auto;
  margin-left: auto;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 28%);
  border-radius: 8px;
  background: rgb(0 0 0 / 55%);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.cell:hover .osd-btn,
.osd-btn:focus-visible,
.live-shell.mobile .osd-btn,
.live-shell.enlarged .osd-btn {
  opacity: 1;
}
.osd-btn:active {
  background: rgb(0 0 0 / 75%);
}
.osd-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}
.ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8b9bb0;
  font-size: 13px;
}
.live-shell.mobile .cell {
  min-height: 140px;
}
.live-shell.mobile .cell.solo,
.live-shell.enlarged .cell.solo {
  min-height: 0;
}
.live-shell.mobile .osd-btn {
  width: 44px;
  height: 44px;
}
.live-shell.mobile .osd-name {
  font-size: 13px;
  padding: 4px 10px;
}
</style>
