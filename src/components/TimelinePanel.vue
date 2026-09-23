<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RecordingSegment } from '@shared/types'
import type { CtxMenuItem } from '@shared/context-menu'
import { openContextMenu } from '../composables/useContextMenu'

const props = defineProps<{
  height: number
  channelId: string | null
  channelName: string | null
  segments: RecordingSegment[]
  savedClips: RecordingSegment[]
  loading?: boolean
  savedClipMinutes?: number
  /** Controlled playing segment id when parent owns the player */
  playingId?: string | null
  /** Whether app is in playback mode */
  active?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  play: [segment: RecordingSegment]
  saveClip: []
  deleteSaved: [segment: RecordingSegment]
  activate: []
  menu: [action: string, payload?: { channelId?: string; segmentId?: string }]
  'update:source': [source: 'loop' | 'saved']
  'update:rate': [rate: number]
}>()

const dayFilter = ref('')
const autoNext = ref(true)
const playbackRate = ref(1)
const source = ref<'loop' | 'saved'>('loop')

const dayOptions = computed(() => {
  const set = new Set<string>()
  for (const s of activeList.value) {
    const d = new Date(s.mtimeMs)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    set.add(key)
  }
  return [...set].sort((a, b) => b.localeCompare(a))
})

const activeList = computed(() => (source.value === 'saved' ? props.savedClips : props.segments))

const filtered = computed(() => {
  if (!dayFilter.value) return activeList.value
  return activeList.value.filter((s) => {
    const d = new Date(s.mtimeMs)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return key === dayFilter.value
  })
})

const title = computed(() => (props.channelName ? props.channelName : '全部通道'))

const saveHint = computed(() => {
  const m = props.savedClipMinutes ?? 10
  return `保存最近约 ${m} 分钟（受保护，不会被自动清理）`
})

defineExpose({
  autoNext,
  playbackRate,
  source,
  filtered,
  playNext,
})

function formatTime(ms: number) {
  return new Date(ms).toLocaleString()
}

function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function setSource(next: 'loop' | 'saved') {
  source.value = next
  emit('update:source', next)
}

function onPlay(seg: RecordingSegment) {
  emit('activate')
  emit('play', seg)
}

function playNext(): RecordingSegment | null {
  if (!props.playingId || !autoNext.value) return null
  const list = filtered.value
  const i = list.findIndex((s) => s.id === props.playingId)
  if (i < 0 || i >= list.length - 1) return null
  const next = list[i + 1]!
  emit('play', next)
  return next
}

function onActivateClick() {
  if (props.active) return
  if (!activeList.value.length) return
  emit('activate')
}

function onPanelCtx(e: MouseEvent) {
  const items: CtxMenuItem[] = [
    { id: 'saveClip', label: '保存最近片段…', disabled: !props.channelId },
    { separator: true },
    { id: 'refresh', label: '刷新列表' },
    { id: 'reveal', label: source.value === 'saved' ? '打开已保存目录' : '打开录像目录' },
    { separator: true },
    { id: 'repairConfig', label: '修复配置' },
  ]
  openContextMenu(e, items, (id) => {
    if (id === 'refresh') {
      emit('refresh')
      return
    }
    if (id === 'saveClip') {
      emit('saveClip')
      return
    }
    if (id === 'reveal' && source.value === 'saved') {
      emit('menu', 'revealSaved', { channelId: props.channelId ?? undefined })
      return
    }
    emit('menu', id, { channelId: props.channelId ?? undefined })
  })
}

function onSegCtx(e: MouseEvent, seg: RecordingSegment) {
  const items: CtxMenuItem[] = [
    { id: 'play', label: '播放' },
    { id: 'reveal', label: '打开所在目录' },
    { separator: true },
  ]
  if (seg.protected) {
    items.push({ id: 'deleteSaved', label: '删除已保存（不可恢复）', danger: true })
  } else {
    items.push({ id: 'saveClip', label: '保存最近片段到受保护目录' })
  }
  items.push({ separator: true }, { id: 'refresh', label: '刷新列表' })

  openContextMenu(e, items, (id) => {
    if (id === 'play') {
      onPlay(seg)
      return
    }
    if (id === 'refresh') {
      emit('refresh')
      return
    }
    if (id === 'deleteSaved') {
      emit('deleteSaved', seg)
      return
    }
    if (id === 'saveClip') {
      emit('saveClip')
      return
    }
    if (id === 'reveal' && seg.protected) {
      emit('menu', 'revealSaved', { channelId: seg.channelId, segmentId: seg.id })
      return
    }
    emit('menu', id, { channelId: seg.channelId, segmentId: seg.id })
  })
}

watch(playbackRate, (r) => emit('update:rate', r))

watch(source, () => {
  dayFilter.value = ''
})
</script>

<template>
  <section
    class="timeline"
    :class="{ active, armed: !active && activeList.length > 0 }"
    :style="{ height: `${height}px` }"
    @contextmenu="onPanelCtx"
    @click="onActivateClick"
  >
    <div class="head">
      <div class="head-left">
        <span class="title">{{ title }}</span>
        <div class="tabs" role="tablist" aria-label="录像来源" @click.stop>
          <button
            type="button"
            role="tab"
            :aria-selected="source === 'loop'"
            :class="{ on: source === 'loop' }"
            @click="setSource('loop')"
          >
            循环
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="source === 'saved'"
            :class="{ on: source === 'saved' }"
            @click="setSource('saved')"
          >
            已保存
            <span v-if="savedClips.length" class="n">{{ savedClips.length }}</span>
          </button>
        </div>
      </div>
      <div class="actions" @click.stop>
        <button
          type="button"
          class="save"
          :disabled="!channelId"
          :title="saveHint"
          @click="emit('saveClip')"
        >
          保存片段
        </button>
        <select v-model="dayFilter" title="按日期筛选" class="day">
          <option value="">全部日期</option>
          <option v-for="d in dayOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model.number="playbackRate" title="播放倍速" class="rate">
          <option :value="0.5">0.5×</option>
          <option :value="1">1×</option>
          <option :value="1.5">1.5×</option>
          <option :value="2">2×</option>
          <option :value="4">4×</option>
        </select>
        <label class="auto" title="播完自动下一片段">
          <input v-model="autoNext" type="checkbox" />
          连续
        </label>
        <button type="button" class="ghost" @click="emit('refresh')">刷新</button>
      </div>
    </div>
    <div class="body">
      <div class="list">
        <p v-if="loading" class="hint">加载中…</p>
        <p v-else-if="!filtered.length" class="hint">
          <template v-if="source === 'saved'">
            暂无已保存片段。录像过程中点「保存片段」可将最近一段时间复制到受保护目录。
          </template>
          <template v-else>
            {{ segments.length ? '该日期无分段。' : '暂无分段。开始录像后会出现在这里。' }}
          </template>
        </p>
        <button
          v-for="seg in filtered"
          :key="seg.id"
          type="button"
          class="seg"
          :class="{ active: playingId === seg.id, locked: seg.protected }"
          @click.stop="onPlay(seg)"
          @contextmenu.stop="onSegCtx($event, seg)"
        >
          <span class="name">
            <span v-if="seg.protected" class="pin" title="受保护，不会自动清理">★</span>
            {{ seg.fileName }}
          </span>
          <span class="meta">{{ formatTime(seg.mtimeMs) }} · {{ formatSize(seg.sizeBytes) }}</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-top: 1px solid var(--border);
  min-height: 0;
  cursor: default;
}
.timeline.armed {
  cursor: pointer;
}
.timeline.active {
  cursor: default;
  box-shadow: inset 0 2px 0 color-mix(in srgb, var(--accent) 55%, transparent);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  cursor: default;
}
.tabs {
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  gap: 2px;
}
.tabs button {
  height: 26px;
  min-width: 64px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.tabs button.on {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}
.tabs .n {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.85;
}
.actions button,
.day,
.rate {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  font-weight: 500;
  color: var(--text);
  font-size: 12px;
}
.actions button.save {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.actions button.ghost {
  background: transparent;
}
.actions button:disabled {
  opacity: 0.45;
  cursor: default;
}
.auto {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.list {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: default;
}
.seg {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
.seg:hover {
  background: var(--hover);
}
.seg.active {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
}
.seg.locked .pin {
  color: var(--accent);
  margin-right: 4px;
}
.name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.meta {
  font-size: 11px;
  color: var(--muted);
}
.hint {
  margin: 8px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}
</style>
