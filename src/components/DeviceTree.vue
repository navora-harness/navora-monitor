<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ChannelConfig, ChannelRuntimeState } from '@shared/types'
import type { CtxMenuItem } from '@shared/context-menu'
import { DEFAULT_GROUP, groupChannels } from '@shared/groups'
import { openContextMenu } from '../composables/useContextMenu'

const props = defineProps<{
  channels: ChannelConfig[]
  states: Record<string, ChannelRuntimeState>
  selectedId: string | null
  activeGroup: string
  groupOrder?: string[]
  /** Remote browser — hide host-only actions */
  remoteMode?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  add: []
  manageGroups: []
  scanDevices: []
  'update:activeGroup': [group: string]
  menu: [action: string, payload?: { channelId?: string; group?: string; channelIds?: string[] }]
  moveToGroup: [ids: string[], group: string]
  moveChannelsBefore: [ids: string[], targetGroup: string, beforeId: string | null]
  moveGroupBefore: [group: string, beforeGroup: string | null]
  batchEnable: [ids: string[], enabled: boolean]
  batchRemove: [ids: string[]]
  batchStart: [ids: string[]]
  batchStop: [ids: string[]]
  rename: [id: string, name: string]
}>()

type DropHint =
  | { kind: 'group'; group: string; before: string | null }
  | { kind: 'channel'; group: string; beforeId: string | null }

const collapsed = ref<Record<string, boolean>>({})
const checkedIds = ref<string[]>([])
const dropHint = ref<DropHint | null>(null)
const draggingKind = ref<'channel' | 'group' | null>(null)
const draggingGroup = ref<string | null>(null)
const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)
const lastClickedId = ref<string | null>(null)
/** Suppress group-head click after a drag so expand/collapse doesn't fight reorder. */
const suppressGroupClick = ref(false)
const searchOpen = ref(false)
const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const addMenuOpen = ref(false)

const buckets = computed(() => {
  const all = groupChannels(props.channels, props.groupOrder)
  const q = searchQuery.value.trim().toLowerCase()
  if (!searchOpen.value || !q) return all
  return all
    .map((b) => {
      const groupHit = b.name.toLowerCase().includes(q)
      return {
        ...b,
        channels: groupHit
          ? b.channels
          : b.channels.filter(
              (c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
            ),
      }
    })
    .filter((b) => b.channels.length > 0)
})
const flatIds = computed(() => buckets.value.flatMap((b) => b.channels.map((c) => c.id)))
const checkedSet = computed(() => new Set(checkedIds.value))
const hasBatch = computed(() => checkedIds.value.length > 1)

function openSearch() {
  searchOpen.value = true
  addMenuOpen.value = false
  window.setTimeout(() => searchInputRef.value?.focus(), 180)
}

function closeSearch() {
  searchOpen.value = false
  searchQuery.value = ''
}

function toggleAddMenu() {
  addMenuOpen.value = !addMenuOpen.value
}

function pickAdd(action: 'device' | 'scan') {
  addMenuOpen.value = false
  if (action === 'device') emit('add')
  else emit('scanDevices')
}

function onDocPointerDown(e: PointerEvent) {
  if (!addMenuOpen.value) return
  const t = e.target as HTMLElement | null
  if (!t?.closest?.('.add-wrap')) addMenuOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onUnmounted(() => document.removeEventListener('pointerdown', onDocPointerDown, true))

watch(
  () => props.channels.map((c) => c.id).join('\0'),
  () => {
    const alive = new Set(props.channels.map((c) => c.id))
    const next = checkedIds.value.filter((id) => alive.has(id))
    if (next.length !== checkedIds.value.length) checkedIds.value = next
    if (lastClickedId.value && !alive.has(lastClickedId.value)) lastClickedId.value = null
  },
)

function stateOf(id: string): ChannelRuntimeState | undefined {
  return props.states[id]
}

function groupRecordingCount(channels: ChannelConfig[]): number {
  return channels.filter((c) => stateOf(c.id)?.recording === 'recording').length
}

function groupMeta(channels: ChannelConfig[]): { total: number; recording: number } {
  return { total: channels.length, recording: groupRecordingCount(channels) }
}

function isGroupLocked(name: string): boolean {
  const bucket = buckets.value.find((b) => b.name === name)
  return !(bucket?.channels.length)
}

function isCollapsed(name: string): boolean {
  if (isGroupLocked(name)) return true
  return !!collapsed.value[name]
}

function toggleCollapse(name: string) {
  if (isGroupLocked(name)) return
  collapsed.value = { ...collapsed.value, [name]: !collapsed.value[name] }
}

function onGroupHeaderClick(name: string) {
  if (suppressGroupClick.value) {
    suppressGroupClick.value = false
    return
  }
  emit('update:activeGroup', name)
  if (isGroupLocked(name)) return
  toggleCollapse(name)
}

function onGroupHeaderDblClick(name: string) {
  suppressGroupClick.value = true
  emit('update:activeGroup', name)
  emit('menu', 'displayGroup', { group: name })
}

function setChecked(ids: string[]) {
  checkedIds.value = [...new Set(ids)]
}

function clearChecked() {
  checkedIds.value = []
}

function bindRenameInput(el: unknown) {
  const input = (el as HTMLInputElement | null) ?? null
  renameInputRef.value = input
  if (!input) return
  // Defer past context-menu teardown / click handlers so focus sticks.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (renameInputRef.value !== input) return
      input.focus({ preventScroll: true })
      const len = input.value.length
      input.setSelectionRange(len, len)
    })
  })
}

async function startRename(ch: ChannelConfig) {
  renamingId.value = ch.id
  renameDraft.value = ch.name
  await nextTick()
  const el = renameInputRef.value
  if (!el) return
  el.focus({ preventScroll: true })
  const len = el.value.length
  el.setSelectionRange(len, len)
}

function cancelRename() {
  renamingId.value = null
  renameDraft.value = ''
}

function commitRename() {
  const id = renamingId.value
  if (!id) return
  const name = renameDraft.value.trim()
  renamingId.value = null
  renameDraft.value = ''
  if (!name) return
  const ch = props.channels.find((c) => c.id === id)
  if (!ch || ch.name === name) return
  emit('rename', id, name)
}

function onNameClick(e: MouseEvent, ch: ChannelConfig) {
  if (!hasBatch.value || renamingId.value) return
  e.stopPropagation()
  void startRename(ch)
}

function onChannelClick(e: MouseEvent, ch: ChannelConfig) {
  if (draggingKind.value || renamingId.value === ch.id) return
  const ids = flatIds.value
  if (e.shiftKey && lastClickedId.value) {
    const a = ids.indexOf(lastClickedId.value)
    const b = ids.indexOf(ch.id)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setChecked(ids.slice(lo, hi + 1))
      lastClickedId.value = ch.id
      emit('select', ch.id)
      return
    }
  }
  if (e.ctrlKey || e.metaKey) {
    const set = new Set(checkedIds.value)
    if (set.has(ch.id)) set.delete(ch.id)
    else set.add(ch.id)
    if (!set.size) set.add(ch.id)
    setChecked([...set])
    lastClickedId.value = ch.id
    emit('select', ch.id)
    return
  }
  setChecked([ch.id])
  lastClickedId.value = ch.id
  emit('select', ch.id)
}

function dragIdsFor(ch: ChannelConfig): string[] {
  if (checkedSet.value.has(ch.id) && checkedIds.value.length > 1) return [...checkedIds.value]
  return [ch.id]
}

function clearDragState() {
  draggingKind.value = null
  draggingGroup.value = null
  dropHint.value = null
}

function onChannelDragStart(e: DragEvent, ch: ChannelConfig) {
  const ids = dragIdsFor(ch)
  draggingKind.value = 'channel'
  draggingGroup.value = null
  e.dataTransfer?.setData('text/channel-id', ch.id)
  e.dataTransfer?.setData('application/x-navora-channel-ids', JSON.stringify(ids))
  e.dataTransfer?.setData('application/x-navora-drag', 'channel')
  e.dataTransfer!.effectAllowed = 'move'
  if (!checkedSet.value.has(ch.id)) setChecked(ids)
}

function onGroupDragStart(e: DragEvent, group: string) {
  suppressGroupClick.value = true
  draggingKind.value = 'group'
  draggingGroup.value = group
  const ids = buckets.value.find((b) => b.name === group)?.channels.map((c) => c.id) ?? []
  e.dataTransfer?.setData('application/x-navora-group', group)
  e.dataTransfer?.setData('application/x-navora-group-channels', JSON.stringify(ids))
  e.dataTransfer?.setData('application/x-navora-drag', 'group')
  e.dataTransfer!.effectAllowed = 'move'
}

function onDragEnd() {
  clearDragState()
  // Keep suppressGroupClick until the trailing click (if any) is handled.
  window.setTimeout(() => {
    suppressGroupClick.value = false
  }, 0)
}

function readDragKind(e: DragEvent): 'channel' | 'group' | null {
  const t = e.dataTransfer?.types
  if (!t) return draggingKind.value
  const types = [...t]
  if (types.includes('application/x-navora-group')) return 'group'
  if (types.includes('application/x-navora-channel-ids') || types.includes('text/channel-id')) return 'channel'
  return draggingKind.value
}

function readDragIds(e: DragEvent): string[] {
  const raw = e.dataTransfer?.getData('application/x-navora-channel-ids')
  if (raw) {
    try {
      const ids = JSON.parse(raw) as unknown
      if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) return ids
    } catch {
      /* fall through */
    }
  }
  const one = e.dataTransfer?.getData('text/channel-id')
  return one ? [one] : []
}

function readDragGroup(e: DragEvent): string | null {
  return e.dataTransfer?.getData('application/x-navora-group') || draggingGroup.value
}

function edgeBefore(e: DragEvent, el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2
}

function onGroupDragOver(e: DragEvent, group: string) {
  const kind = readDragKind(e)
  if (!kind) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  if (kind === 'group') {
    if (draggingGroup.value === group) {
      dropHint.value = null
      return
    }
    const before = edgeBefore(e, e.currentTarget as HTMLElement) ? group : nextGroupAfter(group)
    dropHint.value = { kind: 'group', group, before }
    return
  }
  // Dropping on the group chrome = move into group (append), not insert at first row.
  dropHint.value = { kind: 'channel', group, beforeId: null }
}

function nextGroupAfter(group: string): string | null {
  const names = buckets.value.map((b) => b.name)
  const i = names.indexOf(group)
  if (i < 0 || i >= names.length - 1) return null
  return names[i + 1] ?? null
}

function onChannelDragOver(e: DragEvent, group: string, ch: ChannelConfig) {
  if (readDragKind(e) !== 'channel') return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const before = edgeBefore(e, e.currentTarget as HTMLElement)
  if (before) {
    dropHint.value = { kind: 'channel', group, beforeId: ch.id }
  } else {
    const ids = buckets.value.find((b) => b.name === group)?.channels.map((c) => c.id) ?? []
    const idx = ids.indexOf(ch.id)
    dropHint.value = {
      kind: 'channel',
      group,
      beforeId: idx >= 0 && idx < ids.length - 1 ? (ids[idx + 1] ?? null) : null,
    }
  }
}

function onGroupDragLeave(e: DragEvent, group: string) {
  const related = e.relatedTarget as Node | null
  const current = e.currentTarget as HTMLElement | null
  if (related && current?.contains(related)) return
  const hint = dropHint.value
  if (hint?.kind === 'group' && hint.group === group) dropHint.value = null
  if (hint?.kind === 'channel' && hint.group === group) dropHint.value = null
}

function onGroupDrop(e: DragEvent, group: string) {
  e.preventDefault()
  const kind = readDragKind(e)
  const hint = dropHint.value
  clearDragState()

  if (kind === 'group') {
    const moving = readDragGroup(e)
    if (!moving || moving === group) return
    const before = hint?.kind === 'group' ? hint.before : group
    emit('moveGroupBefore', moving, before === moving ? null : before)
    emit('update:activeGroup', moving)
    return
  }

  const ids = readDragIds(e)
  if (!ids.length) return
  if (hint?.kind === 'channel' && hint.group === group) {
    emit('moveChannelsBefore', ids, group, hint.beforeId)
  } else {
    emit('moveToGroup', ids, group)
  }
  setChecked(ids)
  emit('update:activeGroup', group)
}

function onChannelDrop(e: DragEvent, group: string, ch: ChannelConfig) {
  e.preventDefault()
  e.stopPropagation()
  if (readDragKind(e) !== 'channel') return
  const hint = dropHint.value
  const ids = readDragIds(e)
  clearDragState()
  if (!ids.length) return
  if (ids.includes(ch.id) && ids.length === 1) return
  const beforeId =
    hint?.kind === 'channel' && hint.group === group
      ? hint.beforeId
      : edgeBefore(e, e.currentTarget as HTMLElement)
        ? ch.id
        : null
  emit('moveChannelsBefore', ids, group, beforeId)
  setChecked(ids)
  emit('update:activeGroup', group)
}

function onListDragOver(e: DragEvent) {
  if (readDragKind(e) !== 'group') return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropHint.value = { kind: 'group', group: '', before: null }
}

function onListDrop(e: DragEvent) {
  if (readDragKind(e) !== 'group') return
  e.preventDefault()
  const moving = readDragGroup(e)
  clearDragState()
  if (!moving) return
  emit('moveGroupBefore', moving, null)
  emit('update:activeGroup', moving)
}

function isGroupDropBefore(group: string): boolean {
  const h = dropHint.value
  return h?.kind === 'group' && h.before === group
}

function isGroupDropAfter(group: string): boolean {
  const h = dropHint.value
  if (h?.kind !== 'group' || h.before !== null) return false
  const names = buckets.value.map((b) => b.name)
  return names[names.length - 1] === group
}

function isChannelDropBefore(group: string, channelId: string): boolean {
  const h = dropHint.value
  return h?.kind === 'channel' && h.group === group && h.beforeId === channelId
}

function isChannelDropAfter(group: string, channelId: string): boolean {
  const h = dropHint.value
  if (h?.kind !== 'channel' || h.group !== group || h.beforeId !== null) return false
  const ids = buckets.value.find((b) => b.name === group)?.channels.map((c) => c.id) ?? []
  return ids[ids.length - 1] === channelId
}

function onChannelCtx(e: MouseEvent, ch: ChannelConfig) {
  const batch =
    checkedSet.value.has(ch.id) && checkedIds.value.length > 1 ? [...checkedIds.value] : [ch.id]
  if (!checkedSet.value.has(ch.id)) {
    setChecked([ch.id])
    emit('select', ch.id)
  }

  if (props.remoteMode) {
    if (batch.length > 1) {
      const items: CtxMenuItem[] = [
        { id: 'batchInfo', label: `已选 ${batch.length} 台设备`, disabled: true },
        { separator: true },
        { id: 'displayChannels', label: '展示到宫格' },
      ]
      openContextMenu(e, items, (id) => {
        if (id === 'displayChannels') emit('menu', 'displayChannels', { channelIds: batch })
      })
      return
    }
    emit('select', ch.id)
    const items: CtxMenuItem[] = [
      { id: 'toPreview', label: '放到预览宫格' },
      { id: 'copyUrl', label: '复制主码流 URL' },
    ]
    openContextMenu(e, items, (id) => {
      if (id === 'toPreview') {
        emit('select', ch.id)
        return
      }
      emit('menu', id, { channelId: ch.id })
    })
    return
  }

  if (batch.length > 1) {
    const groupItems: CtxMenuItem[] = buckets.value.map((b) => ({
      id: `move:${b.name}`,
      label: `移到「${b.name}」`,
    }))
    const items: CtxMenuItem[] = [
      { id: 'batchInfo', label: `已选 ${batch.length} 台设备`, disabled: true },
      { separator: true },
      { id: 'batchStart', label: '批量开始录像' },
      { id: 'batchStop', label: '批量停止录像' },
      { separator: true },
      { id: 'batchEnable', label: '批量启用' },
      { id: 'batchDisable', label: '批量停用' },
      { separator: true },
      ...groupItems,
      { id: 'moveNew', label: '移到新分组…' },
      { separator: true },
      { id: 'batchRemove', label: '批量删除', danger: true },
    ]
    openContextMenu(e, items, (id) => {
      if (id === 'batchStart') emit('batchStart', batch)
      else if (id === 'batchStop') emit('batchStop', batch)
      else if (id === 'batchEnable') emit('batchEnable', batch, true)
      else if (id === 'batchDisable') emit('batchEnable', batch, false)
      else if (id === 'batchRemove') emit('batchRemove', batch)
      else if (id === 'moveNew') emit('menu', 'moveNewGroup', { channelIds: batch })
      else if (id.startsWith('move:')) emit('moveToGroup', batch, id.slice(5))
    })
    return
  }

  emit('select', ch.id)
  const st = stateOf(ch.id)
  const recording = st?.recording === 'recording'
  const previewing = st?.preview === 'live' || st?.preview === 'starting'
  const items: CtxMenuItem[] = [
    { id: 'props', label: '属性…' },
    { id: 'rename', label: '修改名称' },
    { separator: true },
    { id: recording ? 'stop' : 'start', label: recording ? '停止录像' : '开始录像', disabled: !recording && !ch.enabled },
    {
      id: previewing ? 'previewStop' : 'previewStart',
      label: previewing ? '停止预览' : '开始预览',
      disabled: !previewing && !ch.enabled,
    },
    { id: 'probe', label: '连通性探测' },
    { separator: true },
    { id: 'reveal', label: '打开录像目录' },
    { id: 'revealSnapshots', label: '打开截图目录' },
    { id: 'copyUrl', label: '复制主码流 URL' },
    { separator: true },
    ...buckets.value
      .filter((b) => b.name !== (ch.group?.trim() || DEFAULT_GROUP))
      .map((b) => ({ id: `move:${b.name}`, label: `移到「${b.name}」` })),
    { id: 'moveNew', label: '移到新分组…' },
    { separator: true },
    { id: ch.enabled ? 'disable' : 'enable', label: ch.enabled ? '停用通道' : '启用通道' },
    { id: 'repairChannel', label: '修复此通道预览' },
    { separator: true },
    { id: 'remove', label: '删除通道', danger: true },
  ]
  openContextMenu(e, items, (id) => {
    if (id === 'rename') {
      // Let the context menu finish closing before focusing the input.
      window.setTimeout(() => {
        void startRename(ch)
      }, 30)
      return
    }
    if (id === 'moveNew') {
      emit('menu', 'moveNewGroup', { channelIds: [ch.id] })
      return
    }
    if (id.startsWith('move:')) {
      emit('moveToGroup', [ch.id], id.slice(5))
      return
    }
    emit('menu', id, { channelId: ch.id })
  })
}

function onGroupCtx(e: MouseEvent, group: string) {
  emit('update:activeGroup', group)
  if (props.remoteMode) {
    const items: CtxMenuItem[] = [
      { id: 'displayGroup', label: '展示到宫格' },
      { id: 'selectGroup', label: '全选本组' },
      {
        id: 'toggleCollapse',
        label: isCollapsed(group) ? '展开分组' : '折叠分组',
        disabled: isGroupLocked(group),
      },
    ]
    openContextMenu(e, items, (id) => {
      if (id === 'toggleCollapse') {
        toggleCollapse(group)
        return
      }
      if (id === 'selectGroup') {
        const ids = buckets.value.find((b) => b.name === group)?.channels.map((c) => c.id) ?? []
        setChecked(ids)
        if (ids[0]) emit('select', ids[0])
        return
      }
      if (id === 'displayGroup') {
        emit('menu', 'displayGroup', { group })
        return
      }
    })
    return
  }
  const items: CtxMenuItem[] = [
    { id: 'startGroup', label: '开始本组录像' },
    { id: 'stopGroup', label: '停止本组录像' },
    { separator: true },
    { id: 'addInGroup', label: '在本组添加设备' },
    { id: 'selectGroup', label: '全选本组' },
    { id: 'toggleCollapse', label: isCollapsed(group) ? '展开分组' : '折叠分组', disabled: isGroupLocked(group) },
    { separator: true },
    { id: 'manageGroups', label: '分组管理…' },
    { id: 'renameGroup', label: '重命名分组…', disabled: group === DEFAULT_GROUP },
    {
      id: 'dissolveGroup',
      label: group === DEFAULT_GROUP ? '解散分组' : (buckets.value.find((b) => b.name === group)?.channels.length ? '解散分组' : '删除空分组'),
      disabled: group === DEFAULT_GROUP,
      danger: true,
    },
    { separator: true },
    { id: 'repairConfig', label: '修复配置' },
  ]
  openContextMenu(e, items, (id) => {
    if (id === 'toggleCollapse') {
      toggleCollapse(group)
      return
    }
    if (id === 'selectGroup') {
      const ids = buckets.value.find((b) => b.name === group)?.channels.map((c) => c.id) ?? []
      setChecked(ids)
      if (ids[0]) emit('select', ids[0])
      return
    }
    emit('menu', id, { group })
  })
}

function onTreeBlankCtx(e: MouseEvent) {
  if (props.remoteMode) {
    const items: CtxMenuItem[] = [{ id: 'refresh', label: '刷新列表' }]
    openContextMenu(e, items, (id) => emit('menu', id, {}))
    return
  }
  const items: CtxMenuItem[] = [
    { id: 'add', label: '添加设备' },
    { id: 'scanDevices', label: '一键扫描' },
    { id: 'manageGroups', label: '分组管理…' },
    { id: 'refresh', label: '刷新列表' },
    { separator: true },
    { id: 'repairConfig', label: '修复配置' },
    { id: 'openSettings', label: '设置…' },
    { id: 'revealAll', label: '打开录像根目录' },
  ]
  openContextMenu(e, items, (id) => {
    if (id === 'manageGroups') {
      emit('manageGroups')
      return
    }
    if (id === 'scanDevices') {
      emit('scanDevices')
      return
    }
    emit('menu', id, {})
  })
}

function batchBarAction(action: 'enable' | 'disable' | 'remove' | 'start' | 'stop' | 'clear') {
  const ids = [...checkedIds.value]
  if (action === 'clear') {
    clearChecked()
    return
  }
  if (!ids.length) return
  if (action === 'enable') emit('batchEnable', ids, true)
  else if (action === 'disable') emit('batchEnable', ids, false)
  else if (action === 'remove') emit('batchRemove', ids)
  else if (action === 'start') emit('batchStart', ids)
  else if (action === 'stop') emit('batchStop', ids)
}
</script>

<template>
  <aside class="tree" :class="{ remote: remoteMode }" @contextmenu="onTreeBlankCtx">
    <div class="head" :class="{ searching: searchOpen }">
      <div class="head-main">
        <div class="head-title">
          <span class="title">设备</span>
          <span class="sub">{{ channels.length }}</span>
        </div>
        <div class="search-field">
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            type="search"
            placeholder="搜索设备 / 分组"
            spellcheck="false"
            @keydown.escape.stop="closeSearch"
          />
        </div>
      </div>
      <div class="head-actions">
        <div v-if="!remoteMode" class="add-wrap" :class="{ open: addMenuOpen }">
          <button
            type="button"
            class="add-btn"
            title="添加"
            :aria-expanded="addMenuOpen"
            aria-haspopup="menu"
            @click.stop="toggleAddMenu"
          >
            添加
            <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M3 4.5 6 7.5 9 4.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <div v-if="addMenuOpen" class="add-menu" role="menu" @click.stop>
            <button type="button" role="menuitem" @click="pickAdd('device')">添加设备</button>
            <button type="button" role="menuitem" @click="pickAdd('scan')">一键扫描</button>
          </div>
        </div>
        <button
          v-if="!remoteMode"
          type="button"
          class="icon-btn"
          title="分组管理"
          @click="emit('manageGroups')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 4.5h5M2.5 8h11M2.5 11.5h8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
            <circle cx="12.2" cy="4.5" r="1.35" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn search"
          :class="{ on: searchOpen }"
          :title="searchOpen ? '退出搜索' : '搜索'"
          @click="searchOpen ? closeSearch() : openSearch()"
        >
          <svg v-if="!searchOpen" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" stroke-width="1.35" />
            <path d="M10.2 10.2 13.5 13.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <div v-if="hasBatch && !remoteMode" class="batch-bar">
      <span class="batch-count">已选 {{ checkedIds.length }}</span>
      <button type="button" class="icon-action rec" title="批量开始录像" @click="batchBarAction('start')">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="currentColor" /></svg>
      </button>
      <button type="button" class="icon-action" title="批量停止录像" @click="batchBarAction('stop')">
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" /></svg>
      </button>
      <button type="button" class="icon-action" title="启用" @click="batchBarAction('enable')">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.2 6.6 11.2 12.5 4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="icon-action" title="停用" @click="batchBarAction('disable')">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M4.5 11.5 11.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" class="icon-action danger" title="删除" @click="batchBarAction('remove')">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 4.5h9M6 4.5V3.4h4V4.5M5.2 4.5l.6 8.1h4.4l.6-8.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="icon-action ghost" title="清除选择" @click="batchBarAction('clear')">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <div
      v-if="buckets.length"
      class="list"
      @dragover="onListDragOver"
      @drop="onListDrop"
    >
      <section
        v-for="bucket in buckets"
        :key="bucket.name"
        class="group"
        :class="{
          active: activeGroup === bucket.name,
          drop: dropHint?.kind === 'channel' && dropHint.group === bucket.name,
          dragging: draggingKind === 'group' && draggingGroup === bucket.name,
          locked: isGroupLocked(bucket.name),
        }"
      >
        <div
          class="drop-line"
          :class="{ on: isGroupDropBefore(bucket.name) }"
          aria-hidden="true"
        />
        <div
          class="group-head"
          draggable="true"
          :title="
            isGroupLocked(bucket.name)
              ? '空分组（已折叠，不可展开）'
              : remoteMode
                ? '单击展开/折叠，双击展示到宫格'
                : '单击展开/折叠，拖动调整顺序'
          "
          @click="onGroupHeaderClick(bucket.name)"
          @dblclick.stop="onGroupHeaderDblClick(bucket.name)"
          @contextmenu.stop="onGroupCtx($event, bucket.name)"
          @dragstart="onGroupDragStart($event, bucket.name)"
          @dragend="onDragEnd"
          @dragover="onGroupDragOver($event, bucket.name)"
          @dragleave="onGroupDragLeave($event, bucket.name)"
          @drop.stop="onGroupDrop($event, bucket.name)"
        >
          <span class="folder" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M2.5 4.25h4.1l1.1 1.35H13.5v6.15a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.25Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <div class="gmeta">
            <div class="gname">{{ bucket.name }}</div>
          </div>
          <span v-if="isCollapsed(bucket.name)" class="gbadges">
            <template v-for="meta in [groupMeta(bucket.channels)]" :key="`${bucket.name}-meta`">
              <span
                v-if="meta.recording"
                class="grec"
                :title="`录像中 ${meta.recording}`"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="5" fill="currentColor" />
                </svg>
                <span v-if="meta.recording > 1" class="grec-n">{{ meta.recording }}</span>
              </span>
              <span class="gcount">{{ meta.total }}</span>
            </template>
          </span>
        </div>
        <ul
          v-show="!isCollapsed(bucket.name)"
          class="channel-list"
          @dragover="onGroupDragOver($event, bucket.name)"
          @dragleave="onGroupDragLeave($event, bucket.name)"
          @drop.stop="onGroupDrop($event, bucket.name)"
        >
          <li
            v-for="ch in bucket.channels"
            :key="ch.id"
            class="channel"
            :draggable="renamingId !== ch.id"
            :class="{
              active: selectedId === ch.id,
              checked: checkedSet.has(ch.id),
              disabled: !ch.enabled,
              dragging: draggingKind === 'channel' && checkedSet.has(ch.id),
            }"
            @click="onChannelClick($event, ch)"
            @dblclick="emit('menu', 'props', { channelId: ch.id })"
            @contextmenu.stop="onChannelCtx($event, ch)"
            @dragstart="onChannelDragStart($event, ch)"
            @dragend="onDragEnd"
            @dragover="onChannelDragOver($event, bucket.name, ch)"
            @drop.stop="onChannelDrop($event, bucket.name, ch)"
          >
            <div class="drop-line" :class="{ on: isChannelDropBefore(bucket.name, ch.id) }" />
            <div class="row">
              <span
                class="status"
                :class="stateOf(ch.id)?.recording ?? 'idle'"
                :title="
                  stateOf(ch.id)?.recording === 'recording'
                    ? '录像中'
                    : stateOf(ch.id)?.recording === 'error'
                      ? '录像异常'
                      : '未录像'
                "
                aria-hidden="true"
              >
                <svg v-if="stateOf(ch.id)?.recording === 'recording'" viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="5" fill="currentColor" />
                </svg>
                <svg v-else-if="stateOf(ch.id)?.recording === 'error'" viewBox="0 0 16 16">
                  <circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M8 4.8v4.2M8 11.2h.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                <i v-else class="idle-dot" />
              </span>
              <div class="meta">
                <div class="name-row">
                  <input
                    v-if="renamingId === ch.id"
                    :ref="bindRenameInput"
                    v-model="renameDraft"
                    class="name-edit"
                    maxlength="64"
                    spellcheck="false"
                    @click.stop
                    @mousedown.stop
                    @dblclick.stop
                    @keydown.enter.prevent="commitRename"
                    @keydown.escape.prevent="cancelRename"
                    @blur="commitRename"
                  />
                  <span
                    v-else
                    class="name"
                    :class="{ editable: hasBatch }"
                    :title="hasBatch ? '点击修改名称' : ch.name"
                    @click="onNameClick($event, ch)"
                  >{{ ch.name }}</span>
                  <span v-if="stateOf(ch.id)?.preview === 'live'" class="pill live" title="预览中">LIVE</span>
                </div>
                <div class="id">{{ ch.id }}</div>
              </div>
            </div>
            <div class="drop-line after" :class="{ on: isChannelDropAfter(bucket.name, ch.id) }" />
          </li>
        </ul>
        <div class="drop-line after" :class="{ on: isGroupDropAfter(bucket.name) }" />
      </section>
    </div>
  </aside>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  min-height: 52px;
}
.head-main {
  flex: 1;
  min-width: 0;
  position: relative;
  height: 32px;
}
.head-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 32px;
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.head.searching .head-title {
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
}
.search-field {
  position: absolute;
  inset: 0;
  display: flex;
  opacity: 0;
  transform: translateY(8px) scale(0.98);
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.head.searching .search-field {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
}
.search-field input {
  width: 100%;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0 10px;
  background: var(--input-bg);
  color: var(--text);
  outline: none;
}
.search-field input:focus {
  border-color: var(--border-strong);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.icon-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.18s ease,
    transform 0.18s ease;
}
.icon-btn svg {
  width: 15px;
  height: 15px;
  display: block;
}
.icon-btn:hover {
  background: var(--hover);
  border-color: var(--border-strong);
  color: var(--accent);
}
.add-wrap {
  position: relative;
  flex-shrink: 0;
  transition: opacity 0.18s ease, transform 0.18s ease, width 0.18s ease;
}
.head.searching .add-wrap {
  opacity: 0;
  transform: scale(0.85);
  width: 0;
  min-width: 0;
  margin: 0;
  pointer-events: none;
  overflow: hidden;
}
.add-btn {
  height: 30px;
  padding: 0 8px 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.add-btn .caret {
  width: 12px;
  height: 12px;
  opacity: 0.7;
  transition: transform 0.15s ease;
}
.add-wrap.open .add-btn {
  border-color: var(--border-strong);
  background: var(--accent-soft);
  color: var(--accent);
}
.add-wrap.open .add-btn .caret {
  transform: rotate(180deg);
}
.add-btn:hover {
  background: var(--hover);
  border-color: var(--border-strong);
  color: var(--accent);
}
.add-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  min-width: 118px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: var(--shadow);
}
.add-menu button {
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  text-align: left;
  font-size: 12px;
  cursor: pointer;
}
.add-menu button:hover {
  background: var(--hover);
  color: var(--accent);
}
.icon-btn.search.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}
.title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.02em;
  flex-shrink: 0;
}
.sub {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.batch-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--accent-soft);
  flex-shrink: 0;
}
.batch-count {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  margin-right: 2px;
  white-space: nowrap;
}
.batch-bar button.icon-action {
  min-width: 30px;
  width: 30px;
  height: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  color: var(--text);
  cursor: pointer;
  line-height: 1;
}
.batch-bar button.icon-action svg {
  width: 14px;
  height: 14px;
  display: block;
}
.batch-bar button.icon-action.rec {
  color: var(--rec);
  border-color: color-mix(in srgb, var(--rec) 35%, var(--border));
  background: color-mix(in srgb, var(--rec) 10%, var(--input-bg));
}
.batch-bar button.icon-action.danger {
  color: var(--danger);
  border-color: transparent;
  background: var(--danger-soft);
}
.batch-bar button.icon-action.ghost {
  border-color: transparent;
  background: transparent;
  color: var(--muted);
}
.batch-bar button.icon-action:hover {
  border-color: var(--border-strong);
  background: var(--hover);
}
.list {
  flex: 1;
  overflow: auto;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.group {
  position: relative;
  border: none;
  border-radius: 0;
  background: transparent;
  transition: opacity 0.12s ease;
  overflow: visible;
}
.group.active .group-head {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  box-shadow: inset 3px 0 0 var(--accent);
}
.group.drop .group-head,
.group.drop .channel-list {
  outline: 1px dashed var(--accent);
  outline-offset: -1px;
  background: color-mix(in srgb, var(--active) 70%, transparent);
}
.group.dragging {
  opacity: 0.45;
}
.group.dragging,
.group.dragging * {
  cursor: grabbing !important;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
}
.group.locked .group-head {
  cursor: default;
  opacity: 0.62;
}
.group.locked .group-head:hover {
  background: var(--surface-2);
  border-color: var(--border);
}
.group-head:hover {
  background: color-mix(in srgb, var(--hover) 55%, var(--surface-2));
  border-color: var(--border-strong);
}
.folder {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--accent);
  opacity: 0.9;
}
.gmeta {
  min-width: 0;
  flex: 1;
}
.gname {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gbadge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 7px;
  line-height: 1.3;
}
.gbadges {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.gcount {
  min-width: 1.4em;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 7px;
  line-height: 1.3;
}
.group.active .gcount {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
}
.grec {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
  padding: 0 6px 0 5px;
  border-radius: 999px;
  color: var(--rec);
  background: color-mix(in srgb, var(--rec) 14%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--rec) 35%, var(--border));
}
.grec svg {
  width: 10px;
  height: 10px;
  display: block;
  flex-shrink: 0;
}
.grec-n {
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.group.active .gbadge {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
  background: var(--panel);
}
.channel-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0 0 0 10px;
  min-height: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 2px solid var(--border);
  margin-left: 14px;
}
.channel {
  position: relative;
  border-radius: 8px;
  padding: 0;
  cursor: pointer;
  border: 1px solid transparent;
  background: var(--panel);
}
.channel.dragging,
.channel.dragging * {
  cursor: grabbing !important;
  opacity: 0.4;
}
.channel:hover {
  background: var(--hover);
  border-color: color-mix(in srgb, var(--border) 80%, transparent);
}
.channel.active {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  box-shadow: none;
}
.channel.checked:not(.active) {
  background: var(--active);
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}
.channel.disabled {
  opacity: 0.5;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 4px;
}
.status {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--scrollbar-thumb);
}
.status svg {
  width: 12px;
  height: 12px;
  display: block;
}
.status .idle-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}
.status.recording {
  color: var(--rec);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--rec) 45%, transparent));
}
.status.error {
  color: var(--danger);
}
.meta {
  min-width: 0;
  flex: 1;
}
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.name.editable {
  cursor: text;
  border-radius: 3px;
  padding: 0 2px;
  margin: 0 -2px;
}
.name.editable:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.name-edit {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  outline: none;
}
.pill {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 999px;
  line-height: 1.4;
}
.pill.live {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 80%, var(--panel));
}
.id {
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
}
.drop-line {
  height: 2px;
  margin: 0 10px;
  border-radius: 2px;
  background: transparent;
  pointer-events: none;
  transition: background 0.08s ease;
}
.drop-line.on {
  background: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}
.drop-line.after {
  margin-top: 0;
}
.empty {
  margin: 20px 14px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.55;
}

/* Remote drawer / touch-friendly rows */
.tree.remote .row {
  padding: 10px 10px 10px 6px;
  min-height: 44px;
}
.tree.remote .group-head {
  min-height: 44px;
  padding: 10px 10px;
}
.tree.remote .name {
  font-size: 14px;
}
.tree.remote .icon-btn,
.tree.remote .add-btn {
  width: 36px;
  height: 36px;
}
</style>
