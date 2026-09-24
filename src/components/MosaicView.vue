<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { ChannelConfig, ChannelRuntimeState } from '@shared/types'
import type { CtxMenuItem } from '@shared/context-menu'
import { channelGroup } from '@shared/groups'
import MpegtsPlayer from './MpegtsPlayer.vue'
import { openContextMenu } from '../composables/useContextMenu'

const props = defineProps<{
  mosaic: 1 | 4 | 9 | 16
  channels: ChannelConfig[]
  states: Record<string, ChannelRuntimeState>
  selectedId: string | null
  slotIds: (string | null)[]
  /** Pause all cell players (window hidden / minimized). */
  playbackSuspended?: boolean
  /** grid = classic mosaic; scroll = vertical stack (mobile remote) */
  layoutMode?: 'grid' | 'scroll'
  /** Hide desktop-only chrome (playback entry, drag empty hints) */
  remoteMode?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  assign: [slotIndex: number, id: string | null]
  assignGroup: [channelIds: string[]]
  swap: [fromIndex: number, toIndex: number]
  snapshot: [channelId: string, dataUrl: string]
  saveClip: [channelId: string]
  enterPlayback: []
  menu: [action: string, payload?: { channelId?: string; slotIndex?: number }]
}>()

const enlargedIndex = ref<number | null>(null)
const playerRefs = ref<Record<number, InstanceType<typeof MpegtsPlayer> | null>>({})
const mosaicShellRef = ref<HTMLElement | null>(null)
const dragFromIndex = ref<number | null>(null)
const dropTargetIndex = ref<number | null>(null)
/** Whole mosaic area in OS fullscreen (multi-channel grid preserved). */
const isFullscreen = ref(false)

/** Per-channel local view prefs (default muted). */
const mutedMap = reactive<Record<string, boolean>>({})
const volumeMap = reactive<Record<string, number>>({})
const flippedMap = reactive<Record<string, boolean>>({})
const pausedMap = reactive<Record<string, boolean>>({})

const cols = computed(() => Math.round(Math.sqrt(props.mosaic)))

const cells = computed(() => {
  const n = props.mosaic
  const out: {
    index: number
    channel: ChannelConfig | null
    state: ChannelRuntimeState | null
  }[] = []
  for (let i = 0; i < n; i++) {
    const id = props.slotIds[i] ?? null
    const channel = id ? props.channels.find((c) => c.id === id) ?? null : null
    const state = id ? props.states[id] ?? null : null
    out.push({ index: i, channel, state })
  }
  return out
})

const visibleCells = computed(() => {
  let list = cells.value
  if (enlargedIndex.value != null) {
    const one = list.find((c) => c.index === enlargedIndex.value)
    list = one ? [one] : list
  } else if (props.layoutMode === 'scroll' && props.remoteMode) {
    const filled = list.filter((c) => c.channel)
    if (filled.length) list = filled
  }
  return list
})

const gridCols = computed(() => (enlargedIndex.value == null ? cols.value : 1))

const activeCell = computed(() => {
  if (!props.selectedId) return null
  return cells.value.find((c) => c.channel?.id === props.selectedId) ?? null
})

const activePreviewing = computed(() => {
  const st = activeCell.value?.state
  return st?.preview === 'live' || st?.preview === 'starting'
})

function isMuted(id: string) {
  return mutedMap[id] !== false
}

function volumeOf(id: string) {
  const v = volumeMap[id]
  return typeof v === 'number' ? v : 0.8
}

function isFlipped(id: string) {
  return !!flippedMap[id]
}

function isPaused(id: string) {
  return !!pausedMap[id]
}

function setPlayerRef(index: number, el: unknown) {
  playerRefs.value[index] = (el as InstanceType<typeof MpegtsPlayer> | null) ?? null
}

function onCellDragStart(e: DragEvent, index: number, channel: ChannelConfig | null) {
  const t = e.target as HTMLElement | null
  if (t?.closest('.toolbar, button, input, .osd-actions')) {
    e.preventDefault()
    return
  }
  if (!channel || enlargedIndex.value != null) {
    e.preventDefault()
    return
  }
  dragFromIndex.value = index
  e.dataTransfer?.setData('application/x-navora-slot-index', String(index))
  e.dataTransfer?.setData('text/channel-id', channel.id)
  e.dataTransfer!.effectAllowed = 'move'
}

function onCellDragEnd() {
  dragFromIndex.value = null
  dropTargetIndex.value = null
}

function readSlotIndex(e: DragEvent): number | null {
  const raw =
    e.dataTransfer?.getData('application/x-navora-slot-index') ||
    (dragFromIndex.value != null ? String(dragFromIndex.value) : '')
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function readGroupChannels(e: DragEvent): string[] | null {
  const raw = e.dataTransfer?.getData('application/x-navora-group-channels')
  if (!raw) return null
  try {
    const ids = JSON.parse(raw) as unknown
    if (Array.isArray(ids) && ids.every((x) => typeof x === 'string') && ids.length) return ids
  } catch {
    /* ignore */
  }
  return null
}

function onDrop(e: DragEvent, index: number) {
  e.preventDefault()
  dropTargetIndex.value = null
  const groupIds = readGroupChannels(e)
  if (groupIds) {
    emit('assignGroup', groupIds)
    dragFromIndex.value = null
    return
  }
  const fromSlot = readSlotIndex(e)
  if (fromSlot != null && fromSlot !== index) {
    emit('swap', fromSlot, index)
    dragFromIndex.value = null
    return
  }
  const id = e.dataTransfer?.getData('text/channel-id')
  if (id) emit('assign', index, id)
  dragFromIndex.value = null
}

function onDragOver(e: DragEvent, index: number) {
  e.preventDefault()
  const types = e.dataTransfer ? [...e.dataTransfer.types] : []
  const fromSlot =
    types.includes('application/x-navora-slot-index') || dragFromIndex.value != null
  const fromGroup = types.includes('application/x-navora-group-channels')
  const fromTree =
    types.includes('text/channel-id') || types.includes('application/x-navora-channel-ids')
  // Must match source effectAllowed ('move'); 'copy' would reject device-tree drops.
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = fromSlot || fromGroup || fromTree ? 'move' : 'copy'
  }
  if (fromSlot && dragFromIndex.value !== index) dropTargetIndex.value = index
  else if (!fromSlot) dropTargetIndex.value = index
}

function onDragLeave(e: DragEvent, index: number) {
  const related = e.relatedTarget as Node | null
  const current = e.currentTarget as HTMLElement | null
  if (related && current?.contains(related)) return
  if (dropTargetIndex.value === index) dropTargetIndex.value = null
}

function previewLabel(state: ChannelRuntimeState | null): string {
  if (!state) return ''
  if (state.preview === 'live') return 'LIVE'
  if (state.preview === 'starting') return '连接中'
  if (state.preview === 'error') return '预览失败'
  return ''
}

function onDblClick(index: number, channel: ChannelConfig | null) {
  if (!channel) return
  enlargedIndex.value = enlargedIndex.value === index ? null : index
}

function exitEnlarge() {
  enlargedIndex.value = null
}

function onSnapshot(index: number, channelId: string) {
  const player = playerRefs.value[index]
  const dataUrl = player?.captureFrame?.() ?? null
  if (!dataUrl) return
  emit('snapshot', channelId, dataUrl)
}

function toggleMute(id: string) {
  mutedMap[id] = !isMuted(id)
}

function setVolume(id: string, raw: number) {
  const v = Math.min(1, Math.max(0, raw))
  volumeMap[id] = v
  if (v <= 0) mutedMap[id] = true
  else mutedMap[id] = false
}

function onVolumeInput(id: string, e: Event) {
  const el = e.target as HTMLInputElement
  setVolume(id, Number(el.value) / 100)
}

function toggleFlip(id: string) {
  flippedMap[id] = !isFlipped(id)
}

function toggleLocalPause(id: string) {
  pausedMap[id] = !isPaused(id)
}

/**
 * OS fullscreen for the whole mosaic shell — keeps multi-channel grid.
 * (One-channel exclusive view is "enlarge", not fullscreen.)
 */
async function toggleFullscreen() {
  const el = mosaicShellRef.value
  if (!el) return
  try {
    if (document.fullscreenElement === el) {
      await document.exitFullscreen()
      return
    }
    if (document.fullscreenElement) await document.exitFullscreen()
    await el.requestFullscreen()
  } catch {
    /* fullscreen unavailable */
  }
}

function onFullscreenChange() {
  const fs = document.fullscreenElement
  isFullscreen.value = !!fs && fs === mosaicShellRef.value
}

function togglePreview() {
  const cell = activeCell.value
  if (!cell?.channel) return
  if (activePreviewing.value) emit('menu', 'previewStop', { channelId: cell.channel.id, slotIndex: cell.index })
  else emit('menu', 'previewStart', { channelId: cell.channel.id, slotIndex: cell.index })
}

function onCellCtx(e: MouseEvent, cell: { index: number; channel: ChannelConfig | null; state: ChannelRuntimeState | null }) {
  if (cell.channel) {
    emit('select', cell.channel.id)
    const recording = cell.state?.recording === 'recording'
    const previewing = cell.state?.preview === 'live' || cell.state?.preview === 'starting'
    const items: CtxMenuItem[] = [
      { id: 'props', label: '属性…' },
      { id: 'enlarge', label: enlargedIndex.value === cell.index ? '还原画面' : '放大画面（一路独占）' },
      {
        id: 'fullscreen',
        label: isFullscreen.value ? '退出全屏' : '全屏播放（多路宫格）',
      },
      { id: 'snapshot', label: '截图' },
      { id: 'saveClip', label: '框选保存片段' },
      { separator: true },
      { id: recording ? 'stop' : 'start', label: recording ? '停止录像' : '开始录像' },
      { id: previewing ? 'previewStop' : 'previewStart', label: previewing ? '停止预览' : '开始预览' },
      { id: 'repairChannel', label: '修复此通道预览' },
      { separator: true },
      { id: 'clearSlot', label: '移出宫格' },
      { id: 'reveal', label: '打开录像目录' },
      { id: 'revealSaved', label: '打开已保存目录' },
    ]
    openContextMenu(e, items, (id) => {
      if (id === 'enlarge') {
        onDblClick(cell.index, cell.channel)
        return
      }
      if (id === 'fullscreen') {
        void toggleFullscreen()
        return
      }
      if (id === 'snapshot') {
        onSnapshot(cell.index, cell.channel!.id)
        return
      }
      if (id === 'saveClip') {
        emit('saveClip', cell.channel!.id)
        return
      }
      if (id === 'clearSlot') {
        emit('assign', cell.index, null)
        return
      }
      emit('menu', id, { channelId: cell.channel!.id, slotIndex: cell.index })
    })
    return
  }

  const items: CtxMenuItem[] = [
    {
      id: 'assignSelected',
      label: '将选中通道放到此格',
      disabled: !props.selectedId,
    },
    {
      id: 'fullscreen',
      label: isFullscreen.value ? '退出全屏' : '全屏播放（多路宫格）',
    },
    { separator: true },
    { id: 'repairConfig', label: '修复配置' },
  ]
  openContextMenu(e, items, (id) => {
    if (id === 'assignSelected' && props.selectedId) {
      emit('assign', cell.index, props.selectedId)
      return
    }
    if (id === 'fullscreen') {
      void toggleFullscreen()
      return
    }
    emit('menu', id, { slotIndex: cell.index })
  })
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
    return
  }
  exitEnlarge()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFullscreenChange)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
})
</script>

<template>
  <div
    ref="mosaicShellRef"
    class="mosaic-shell"
    :class="{ remote: remoteMode, scroll: layoutMode === 'scroll', fs: isFullscreen }"
  >
    <div
      class="mosaic"
      :style="{ '--cols': gridCols }"
      :class="{ enlarged: enlargedIndex != null, scroll: layoutMode === 'scroll' }"
    >
      <div
        v-for="cell in visibleCells"
        :key="cell.index"
        class="cell"
        :class="{
          active: cell.channel && selectedId === cell.channel.id,
          empty: !cell.channel,
          dragging: dragFromIndex === cell.index,
          droptarget: dropTargetIndex === cell.index && dragFromIndex !== cell.index,
        }"
        :draggable="!!cell.channel && enlargedIndex == null"
        @click="cell.channel && emit('select', cell.channel.id)"
        @dblclick="onDblClick(cell.index, cell.channel)"
        @contextmenu="onCellCtx($event, cell)"
        @dragstart="onCellDragStart($event, cell.index, cell.channel)"
        @dragend="onCellDragEnd"
        @dragover="onDragOver($event, cell.index)"
        @dragleave="onDragLeave($event, cell.index)"
        @drop="onDrop($event, cell.index)"
      >
        <template v-if="cell.channel">
          <div class="osd">
            <span class="meta">
              <span class="group">{{ channelGroup(cell.channel) }}</span>
              <span class="sep">·</span>
              <span class="name">{{ cell.channel.name }}</span>
            </span>
            <span v-if="cell.state?.recording === 'recording'" class="badge rec">REC</span>
            <span
              v-if="previewLabel(cell.state)"
              class="badge"
              :class="{ live: cell.state?.preview === 'live', warn: cell.state?.preview !== 'live' }"
            >
              {{ previewLabel(cell.state) }}
            </span>
            <div class="osd-actions">
              <button
                type="button"
                class="osd-btn"
                :title="enlargedIndex === cell.index ? '还原宫格（Esc）' : '放大（一路独占）'"
                @click.stop="onDblClick(cell.index, cell.channel)"
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
          </div>
          <MpegtsPlayer
            v-if="cell.state?.previewUrl && (cell.state.preview === 'live' || cell.state.preview === 'starting')"
            :ref="(el) => setPlayerRef(cell.index, el)"
            :src="cell.state.previewUrl"
            :muted="isMuted(cell.channel.id)"
            :volume="volumeOf(cell.channel.id)"
            :mirrored="isFlipped(cell.channel.id)"
            :paused="isPaused(cell.channel.id) || !!playbackSuspended"
          />
          <div v-else class="placeholder">
            <p v-if="cell.state?.preview === 'error'">{{ cell.state.previewError || '预览失败' }}</p>
            <p v-else>等待预览…</p>
            <p class="hint">低延迟 MPEG-TS 预览（H.264）；H.265 浏览器可能无法播放</p>
          </div>
        </template>
        <template v-else>
          <div class="placeholder empty">
            <p>空位 {{ cell.index + 1 }}</p>
            <p v-if="!remoteMode" class="hint">拖入通道或整组设备到此</p>
          </div>
        </template>
      </div>
    </div>

    <div class="toolbar">
      <template v-if="activeCell?.channel">
        <span
          class="tb-meta"
          :title="`${channelGroup(activeCell.channel)} · ${activeCell.channel.name}`"
        >
          <span class="tb-group">{{ channelGroup(activeCell.channel) }}</span>
          <span class="tb-sep-dot">·</span>
          <span class="tb-name">{{ activeCell.channel.name }}</span>
        </span>
        <button
          type="button"
          class="tb-btn mode"
          title="进入回放模式"
          @click="emit('enterPlayback')"
        >
          回放
        </button>
        <span class="tb-sep" />
        <button
          type="button"
          class="tb-btn"
          :title="activePreviewing ? '停止预览' : '开始预览'"
          @click="togglePreview"
        >
          <svg v-if="!activePreviewing" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3.5v9l8-4.5-8-4.5Z" fill="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn"
          :disabled="!activePreviewing"
          :title="isPaused(activeCell.channel.id) ? '继续播放' : '暂停画面'"
          @click="toggleLocalPause(activeCell.channel.id)"
        >
          <svg v-if="isPaused(activeCell.channel.id)" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3.5v9l8-4.5-8-4.5Z" fill="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4" y="3.5" width="2.8" height="9" rx="0.6" fill="currentColor" />
            <rect x="9.2" y="3.5" width="2.8" height="9" rx="0.6" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn"
          :class="{ on: !isMuted(activeCell.channel.id) }"
          :title="isMuted(activeCell.channel.id) ? '取消静音' : '静音'"
          @click="toggleMute(activeCell.channel.id)"
        >
          <svg v-if="isMuted(activeCell.channel.id)" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 6.5h2.2L8.5 4v8L5.2 9.5H3V6.5Zm7.2-.7 1.3 1.3 1.3-1.3.9.9-1.3 1.3 1.3 1.3-.9.9-1.3-1.3-1.3 1.3-.9-.9 1.3-1.3-1.3-1.3.9-.9Z"
              fill="currentColor"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 6.5h2.2L8.5 4v8L5.2 9.5H3V6.5Zm6.2-1.2a3.2 3.2 0 0 1 0 5.4l-.8-.9a2.1 2.1 0 0 0 0-3.6l.8-.9Zm1.6-1.6a5.2 5.2 0 0 1 0 8.6l-.85-.9a4 4 0 0 0 0-6.8l.85-.9Z"
              fill="currentColor"
            />
          </svg>
        </button>
        <input
          class="vol"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="Math.round(volumeOf(activeCell.channel.id) * 100)"
          :title="`音量 ${Math.round(volumeOf(activeCell.channel.id) * 100)}%`"
          @input="onVolumeInput(activeCell.channel.id, $event)"
          @click.stop
        />
        <button
          type="button"
          class="tb-btn"
          :class="{ on: isFlipped(activeCell.channel.id) }"
          title="镜头水平翻转"
          @click="toggleFlip(activeCell.channel.id)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 8h11M5 5.2 2.5 8 5 10.8M11 5.2 13.5 8 11 10.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <span class="tb-sep" />
        <button
          type="button"
          class="tb-btn"
          title="截图"
          @click="onSnapshot(activeCell.index, activeCell.channel.id)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.2 3.5h1.1l.7-1.2h2l.7 1.2h1.1A1.7 1.7 0 0 1 12.5 5.2v5.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
            />
            <circle cx="8" cy="8.1" r="2.1" fill="none" stroke="currentColor" stroke-width="1.25" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn save"
          title="框选保存片段"
          @click="emit('saveClip', activeCell.channel.id)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 2.75h6.2L13.25 6v7.25H4V2.75Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linejoin="round"
            />
            <path d="M6 2.75v3.5h4.5" fill="none" stroke="currentColor" stroke-width="1.25" />
          </svg>
        </button>
        <button
          type="button"
          class="tb-btn"
          :class="{ on: isFullscreen }"
          :title="isFullscreen ? '退出全屏（Esc）' : '全屏播放（多路宫格）'"
          @click="toggleFullscreen"
        >
          <svg v-if="isFullscreen" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.5 3.5H3.5v2M10.5 3.5h2v2M5.5 12.5H3.5v-2M10.5 12.5h2v-2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 5.5V2.5h3M10.5 2.5h3v3M2.5 10.5v3h3M13.5 10.5v3h-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </template>
      <template v-else>
        <span class="tb-empty">选择一个画面以使用底部控制</span>
        <button
          type="button"
          class="tb-btn end"
          :class="{ on: isFullscreen }"
          :title="isFullscreen ? '退出全屏（Esc）' : '全屏播放（多路宫格）'"
          @click="toggleFullscreen"
        >
          <svg v-if="isFullscreen" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M5.5 3.5H3.5v2M10.5 3.5h2v2M5.5 12.5H3.5v-2M10.5 12.5h2v-2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 5.5V2.5h3M10.5 2.5h3v3M2.5 10.5v3h3M13.5 10.5v3h-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mosaic-shell {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #1a2332;
}
.mosaic-shell:fullscreen,
.mosaic-shell:-webkit-full-screen {
  width: 100%;
  height: 100%;
  background: #0a0e14;
}
.mosaic-shell:fullscreen .mosaic,
.mosaic-shell:-webkit-full-screen .mosaic {
  flex: 1 1 0;
}
.mosaic {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  grid-template-rows: repeat(var(--cols), minmax(0, 1fr));
  gap: 2px;
  padding: 2px;
  overflow: hidden;
}
.mosaic.enlarged {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.mosaic.scroll {
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
}
.mosaic.scroll .cell {
  flex: 0 0 auto;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
  min-height: 160px;
  max-height: min(62vh, 420px);
  border-radius: 10px;
  border: 1px solid rgb(255 255 255 / 8%);
}
.mosaic-shell.scroll .toolbar {
  display: none;
}
.mosaic-shell.remote .toolbar {
  padding-bottom: max(8px, env(safe-area-inset-bottom));
}
.cell {
  position: relative;
  background: #0f161f;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}
.cell[draggable='true'] {
  cursor: pointer;
}
.cell.dragging,
.cell.dragging * {
  cursor: grabbing !important;
}
.cell.active {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.cell.dragging {
  opacity: 0.45;
}
.cell.droptarget {
  outline: 2px dashed color-mix(in srgb, var(--accent) 85%, #fff);
  outline-offset: -3px;
  background: color-mix(in srgb, var(--accent) 12%, #0f161f);
}
.osd {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: linear-gradient(to bottom, rgb(0 0 0 / 55%), transparent);
  color: #fff;
  font-size: 12px;
  z-index: 2;
  pointer-events: none;
}
.osd .meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: calc(100% - 100px);
  font-weight: 650;
}
.osd .group {
  flex-shrink: 0;
  max-width: 72px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.78;
  font-weight: 600;
}
.osd .sep {
  flex-shrink: 0;
  opacity: 0.5;
}
.osd .name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.osd-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  pointer-events: auto;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.cell:hover .osd-actions,
.osd-actions:focus-within {
  opacity: 1;
}
.osd-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 22%);
  border-radius: 6px;
  background: rgb(0 0 0 / 45%);
  color: #fff;
  cursor: pointer;
}
.osd-btn:hover {
  background: rgb(0 0 0 / 65%);
  border-color: rgb(255 255 255 / 40%);
}
.osd-btn svg {
  width: 15px;
  height: 15px;
  display: block;
}
.name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  letter-spacing: 0.04em;
}
.badge.rec {
  background: var(--rec);
}
.badge.live {
  background: var(--accent);
}
.badge.warn {
  background: #b54708;
}
.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #9aa7b5;
  font-size: 13px;
  text-align: center;
  padding: 16px;
  pointer-events: none;
}
.placeholder.empty {
  inset: 8px;
  border: 1px dashed rgb(255 255 255 / 12%);
  border-radius: 8px;
}
.hint {
  font-size: 11px;
  opacity: 0.7;
}
.toolbar {
  flex-shrink: 0;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border-top: 1px solid rgb(255 255 255 / 10%);
  background: #121820;
  color: #e8edf2;
}
.tb-empty {
  flex: 1;
  font-size: 12px;
  color: #8b98a8;
}
.tb-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: #c5d0db;
}
.tb-group {
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8b98a8;
  font-weight: 650;
}
.tb-sep-dot {
  flex-shrink: 0;
  color: #6a7786;
  font-weight: 500;
}
.tb-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #e8edf2;
}
.tb-sep {
  width: 1px;
  height: 18px;
  background: rgb(255 255 255 / 12%);
  margin: 0 4px;
}
.tb-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 14%);
  border-radius: 6px;
  background: rgb(255 255 255 / 6%);
  color: #e8edf2;
  cursor: pointer;
}
.tb-btn.end {
  margin-left: auto;
}
.tb-btn svg {
  width: 14px;
  height: 14px;
  display: block;
}
.tb-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 12%);
}
.tb-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.tb-btn.on {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.vol {
  width: 88px;
  height: 28px;
  margin: 0 2px;
  accent-color: var(--accent);
  cursor: pointer;
  vertical-align: middle;
}
.tb-btn.save {
  border-color: rgb(183 228 213 / 40%);
  background: rgb(15 110 86 / 45%);
}
.tb-btn.mode {
  width: auto;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
</style>
