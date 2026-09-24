<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AppInfo, ChannelConfig, ChannelRuntimeState, RecordingSegment } from '@shared/types'
import { DEFAULT_GROUP, channelGroup, listGroups, normalizeGroupName } from '@shared/groups'
import {
  PANEL_LIMITS,
  defaultUiLayout,
  emptySlotIds,
  sanitizeUiLayout,
  type PanelSizes,
  type UiLayoutState,
} from '@shared/panel-sizes'
import type { DiskSpaceInfo, StorageAction } from '@shared/ipc-types'
import { formatDurationLabel, formatGbLabel } from '@shared/storage-policy'
import TitleBar from './components/TitleBar.vue'
import DeviceTree from './components/DeviceTree.vue'
import MosaicView from './components/MosaicView.vue'
import PlaybackView from './components/PlaybackView.vue'
import GroupsDialog from './components/GroupsDialog.vue'
import DeviceScanDialog from './components/DeviceScanDialog.vue'
import ConfigTransferDialog from './components/ConfigTransferDialog.vue'
import ChannelDialog from './components/ChannelDialog.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import StatusBar from './components/StatusBar.vue'
import ResizeHandle from './components/ResizeHandle.vue'
import SettingsView from './components/SettingsView.vue'
import ContextMenuHost from './components/ContextMenuHost.vue'
import type { AppSettings } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { applyUiTheme, type UiTheme } from './theme'

function api() {
  return window.navoraMonitor
}

const info = ref<AppInfo | null>(null)
const channels = ref<ChannelConfig[]>([])
const groupOrder = ref<string[]>([])
const states = ref<Record<string, ChannelRuntimeState>>({})
const selectedId = ref<string | null>(null)
const status = ref('就绪')
const slotIds = ref<(string | null)[]>(emptySlotIds())
const diskSpace = ref<DiskSpaceInfo | null>(null)
const segments = ref<RecordingSegment[]>([])
const savedClips = ref<RecordingSegment[]>([])
const segmentsLoading = ref(false)
const probeMessage = ref<string | null>(null)
const probing = ref(false)
const activeGroup = ref(DEFAULT_GROUP)
const showSettings = ref(false)
const settingsInitialCat = ref<'appearance' | 'about'>('appearance')
const showChannelDialog = ref(false)
const showGroupsDialog = ref(false)
const showScanDialog = ref(false)
const configWizard = ref<'export' | 'import' | null>(null)
const configImportPath = ref<string | null>(null)
const configDropActive = ref(false)
let configDropDepth = 0
/** False when window hidden/minimized — pause live & playback UI, stop preview ffmpeg. */
const windowVisible = ref(true)
let unsubWindowVisibility: (() => void) | null = null
const channelDraft = ref<ChannelConfig | null>(null)
const appSettings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
const viewMode = ref<'live' | 'playback'>('live')
const playbackSeg = ref<RecordingSegment | null>(null)
const exportBusy = ref(false)
const playbackScrubWallMs = ref<number | null>(null)
const playbackScrubNonce = ref(0)
const playbackPlayId = ref<string | null>(null)
const playbackPlayNonce = ref(0)
const playbackFollowMs = ref<number | null>(null)
const playbackRate = ref(1)
const playbackContinuous = ref(true)
const playbackBusy = ref(false)
const timelineSource = ref<'loop' | 'saved'>('loop')
const playbackPlaylist = computed(() =>
  timelineSource.value === 'saved' ? savedClips.value : segments.value,
)
const timelineRef = ref<InstanceType<typeof TimelinePanel> | null>(null)

const layout = reactive<UiLayoutState>(defaultUiLayout())
let layoutTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null
let diskTimer: ReturnType<typeof setInterval> | null = null
let unsubStorageAction: (() => void) | null = null
let unsubStorageChanged: (() => void) | null = null

const selected = computed(() => channels.value.find((c) => c.id === selectedId.value) ?? null)
const dialogChannel = computed(() => channelDraft.value ?? selected.value)
const dialogState = computed(() => {
  const id = dialogChannel.value?.id
  return id ? states.value[id] ?? null : null
})
const recordingCount = computed(
  () => Object.values(states.value).filter((s) => s.recording === 'recording').length,
)
/** Live mode + timeline visible + live preview playing → playhead tracks "now". */
const timelineFollowLiveEdge = computed(() => {
  if (viewMode.value !== 'live') return false
  if (!layout.showTimeline) return false
  if (!windowVisible.value) return false
  const ids = slotIds.value.slice(0, layout.mosaic).filter((x): x is string => !!x)
  return ids.some((id) => {
    const st = states.value[id]
    return st?.preview === 'live' || st?.preview === 'starting'
  })
})
const groups = computed(() => listGroups(channels.value, groupOrder.value))

watch(groups, (gs) => {
  if (!gs.includes(activeGroup.value)) {
    activeGroup.value = gs[0] ?? DEFAULT_GROUP
  }
})

async function refreshChannels() {
  channels.value = await api().listChannels()
  groupOrder.value = await api().getGroupOrder()
  const alive = new Set(channels.value.map((c) => c.id))
  setSlotIds(slotIds.value.map((x) => (x && alive.has(x) ? x : null)))
  if (selectedId.value && !alive.has(selectedId.value)) {
    selectedId.value = channels.value[0]?.id ?? null
    if (showChannelDialog.value && !channelDraft.value) closeChannelDialog()
  }
  if (!selectedId.value && channels.value[0]) {
    selectedId.value = channels.value[0].id
    ensureSlot(channels.value[0].id)
  }
}

async function refreshStates() {
  const list = await api().getRuntimeStates()
  const map: Record<string, ChannelRuntimeState> = {}
  for (const s of list) map[s.id] = s
  states.value = map
}

async function refreshInfo() {
  info.value = await api().getAppInfo()
}

async function refreshRecordings(opts?: { silent?: boolean }) {
  if (!opts?.silent) segmentsLoading.value = true
  try {
    const id = selectedId.value ?? undefined
    const [loop, saved] = await Promise.all([
      api().listRecordings(id),
      api().listSavedClips(id),
    ])
    segments.value = loop
    savedClips.value = saved
  } finally {
    if (!opts?.silent) segmentsLoading.value = false
  }
}

function setSlotIds(next: (string | null)[]) {
  slotIds.value = next
  layout.slotIds = [...next]
  scheduleSaveLayout()
}

function ensureSlot(id: string) {
  if (slotIds.value.includes(id)) return
  const empty = slotIds.value.findIndex((x) => !x)
  if (empty >= 0) {
    const next = [...slotIds.value]
    next[empty] = id
    setSlotIds(next)
    return
  }
  setSlotIds([id, ...slotIds.value.slice(1)])
}

function mosaicForCount(n: number): 1 | 4 | 9 | 16 {
  if (n <= 1) return 1
  if (n <= 4) return 4
  if (n <= 9) return 9
  return 16
}

function onAssignSlot(index: number, id: string | null) {
  const next = [...slotIds.value]
  if (!id) {
    next[index] = null
  } else {
    const from = next.findIndex((x) => x === id)
    if (from >= 0 && from !== index) {
      // Already on wall → move that pane to the drop target (swap with occupant).
      next[from] = next[index] ?? null
      next[index] = id
    } else {
      next[index] = id
    }
  }
  setSlotIds(next)
  if (id) selectedId.value = id
  scheduleSyncPreviews()
}

function onAssignGroup(channelIds: string[]) {
  const ids = [...new Set(channelIds)].filter((id) => channels.value.some((c) => c.id === id))
  if (!ids.length) return
  const mosaic = mosaicForCount(ids.length)
  layout.mosaic = mosaic
  const next = emptySlotIds()
  for (let i = 0; i < mosaic; i++) next[i] = ids[i] ?? null
  setSlotIds(next)
  selectedId.value = ids[0] ?? null
  const ch = channels.value.find((c) => c.id === ids[0])
  if (ch) activeGroup.value = channelGroup(ch)
  status.value = `已展示分组 ${ids.length} 路（${mosaic} 宫格）`
  scheduleSyncPreviews()
}

function onSwapSlots(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return
  const next = [...slotIds.value]
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= next.length || toIndex >= next.length) return
  const tmp = next[fromIndex] ?? null
  next[fromIndex] = next[toIndex] ?? null
  next[toIndex] = tmp
  setSlotIds(next)
  const focus = next[toIndex]
  if (focus) selectedId.value = focus
  scheduleSyncPreviews()
}

function setPanelSize(key: keyof PanelSizes, value: number) {
  layout.panelSizes = { ...layout.panelSizes, [key]: value }
  scheduleSaveLayout()
}

function setMosaic(n: 1 | 4 | 9 | 16) {
  layout.mosaic = n
  scheduleSaveLayout()
  scheduleSyncPreviews()
}

function setShowExplorer(v: boolean) {
  layout.showExplorer = v
  scheduleSaveLayout()
}

function setShowTimeline(v: boolean) {
  layout.showTimeline = v
  scheduleSaveLayout()
}

function enterPlayback(seg?: RecordingSegment | null) {
  const hasClips = segments.value.length > 0 || savedClips.value.length > 0
  if (!seg && !hasClips) {
    status.value = '暂无录像片段，无法进入回放'
    if (!layout.showTimeline) setShowTimeline(true)
    return
  }
  viewMode.value = 'playback'
  if (!layout.showTimeline) setShowTimeline(true)
  if (seg) playbackSeg.value = seg
  void refreshRecordings()
}

function exitPlayback() {
  viewMode.value = 'live'
  playbackSeg.value = null
  playbackScrubWallMs.value = null
  playbackPlayId.value = null
  playbackFollowMs.value = null
  playbackBusy.value = false
}

function onPlaybackPlay(seg: RecordingSegment) {
  if (seg.protected) timelineSource.value = 'saved'
  else timelineSource.value = 'loop'
  playbackPlayId.value = seg.id
  playbackPlayNonce.value += 1
  playbackFollowMs.value = seg.startMs ?? seg.mtimeMs
  if (viewMode.value !== 'playback') viewMode.value = 'playback'
  if (!layout.showTimeline) setShowTimeline(true)
}

function onTimelineScrub(payload: {
  atMs: number
  segment: RecordingSegment | null
  seekSec: number
}) {
  if (playbackBusy.value) return
  if (viewMode.value !== 'playback') viewMode.value = 'playback'
  if (!layout.showTimeline) setShowTimeline(true)
  // Do not write followMs here — avoids fighting the player follow throttle during seek
  playbackScrubWallMs.value = payload.atMs
  playbackScrubNonce.value += 1
}

function onPlaybackFollow(wallMs: number) {
  playbackFollowMs.value = wallMs
}

function onPlaybackSegment(seg: RecordingSegment | null) {
  playbackSeg.value = seg
}

function onPlaylistEnded() {
  status.value = '回放列表已播完'
}

function scheduleSaveLayout() {
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    layout.slotIds = [...slotIds.value]
    void api().setLayout(sanitizeUiLayout(layout))
  }, 200)
}

function activeSlotIds(): string[] {
  return slotIds.value.slice(0, layout.mosaic).filter((x): x is string => !!x)
}

function scheduleSyncPreviews() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    void (async () => {
      if (!windowVisible.value) {
        await api().syncPreviews([])
        await refreshStates()
        return
      }
      await api().syncPreviews(activeSlotIds())
      await refreshStates()
      const errs = activeSlotIds()
        .map((id) => states.value[id])
        .filter((s) => s?.preview === 'error' && s.previewError)
      if (errs.length === 1) {
        status.value = `预览失败：${errs[0]!.previewError}`
      } else if (errs.length > 1) {
        status.value = `${errs.length} 路预览失败（见画面提示）`
      }
    })()
  }, 250)
}

async function onWindowVisibility(p: { visible: boolean }) {
  const next = !!p.visible
  if (windowVisible.value === next) return
  windowVisible.value = next
  if (!next) {
    if (syncTimer) clearTimeout(syncTimer)
    try {
      await api().syncPreviews([])
      await refreshStates()
    } catch {
      /* ignore */
    }
    status.value = '窗口已隐藏 · 预览已暂停（录像仍继续）'
  } else {
    scheduleSyncPreviews()
    status.value = '窗口已恢复 · 正在恢复预览'
  }
}

function onSelect(id: string) {
  selectedId.value = id
  ensureSlot(id)
  probeMessage.value = null
  const ch = channels.value.find((c) => c.id === id)
  if (ch) activeGroup.value = channelGroup(ch)
  scheduleSyncPreviews()
  void refreshRecordings()
}

function startAdd(group?: string) {
  const g = group ?? activeGroup.value
  channelDraft.value = {
    id: `cam-${Date.now().toString(36)}`,
    name: '新通道',
    url: '',
    enabled: true,
    segmentTimeSec: appSettings.value.defaultSegmentTimeSec,
    rtspTransport: appSettings.value.defaultRtspTransport,
    group: g === DEFAULT_GROUP ? undefined : g,
  }
  probeMessage.value = null
  showChannelDialog.value = true
}

function openScanDialog() {
  showScanDialog.value = true
}

async function onScanAdd(list: ChannelConfig[]) {
  if (!list.length) return
  try {
    channels.value = await api().upsertChannels(list)
    groupOrder.value = await api().getGroupOrder()
    showScanDialog.value = false
    selectedId.value = list[0]?.id ?? selectedId.value
    if (list[0]) ensureSlot(list[0].id)
    status.value = `已添加 ${list.length} 路扫描设备`
    scheduleSyncPreviews()
    await refreshStates()
  } catch (e) {
    status.value = e instanceof Error ? e.message : '添加失败'
  }
}

function openChannelProps(id?: string) {
  channelDraft.value = null
  if (id) {
    if (!channels.value.some((c) => c.id === id)) return
    selectedId.value = id
    ensureSlot(id)
  }
  if (!channels.value.some((c) => c.id === selectedId.value)) return
  showChannelDialog.value = true
  probeMessage.value = null
}

function closeChannelDialog() {
  showChannelDialog.value = false
  channelDraft.value = null
  probeMessage.value = null
}

async function onRepairConfig() {
  const res = await api().repairConfig(activeSlotIds())
  await refreshChannels()
  await refreshStates()
  await refreshInfo()
  status.value = res.messages.join(' · ')
}

async function onExportConfig() {
  configImportPath.value = null
  configWizard.value = 'export'
}

async function onImportConfig(filePath?: string) {
  configImportPath.value = filePath?.trim() || null
  configWizard.value = 'import'
}

function closeConfigWizard() {
  configWizard.value = null
  configImportPath.value = null
  configDropActive.value = false
  configDropDepth = 0
}

function isExternalFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  const list = Array.from(types)
  // Ignore in-app channel / slot drags
  if (list.some((t) => t.startsWith('application/x-navora-'))) return false
  return list.includes('Files')
}

function pathFromConfigDrop(e: DragEvent): string | null {
  const files = e.dataTransfer?.files
  if (!files?.length) return null
  for (let i = 0; i < files.length; i++) {
    const f = files.item(i)
    if (!f) continue
    const p = (f as File & { path?: string }).path?.trim() || ''
    const name = f.name || p
    if (/\.json$/i.test(name) || /\.json$/i.test(p)) return p || null
  }
  return null
}

function onShellDragEnter(e: DragEvent) {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  configDropDepth += 1
  configDropActive.value = true
}

function onShellDragOver(e: DragEvent) {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  configDropActive.value = true
}

function onShellDragLeave(e: DragEvent) {
  if (!isExternalFileDrag(e)) return
  configDropDepth = Math.max(0, configDropDepth - 1)
  if (configDropDepth === 0) configDropActive.value = false
}

async function onShellDrop(e: DragEvent) {
  if (!isExternalFileDrag(e)) return
  e.preventDefault()
  configDropDepth = 0
  configDropActive.value = false
  const path = pathFromConfigDrop(e)
  if (!path) {
    status.value = '请拖入 Navora Monitor 配置 .json 文件'
    return
  }
  showSettings.value = false
  // Remount dialog so initialPath is inspected even if import wizard was already open
  if (configWizard.value) {
    configWizard.value = null
    configImportPath.value = null
    await nextTick()
  }
  await onImportConfig(path)
}

async function onConfigWizardDone(message: string) {
  status.value = message
  if (!message.startsWith('已导入')) return
  await refreshChannels()
  groupOrder.value = await api().getGroupOrder()
  appSettings.value = await api().getSettings()
  applyUiTheme(appSettings.value.uiTheme)
  const layoutState = await api().getLayout()
  Object.assign(layout, sanitizeUiLayout(layoutState))
  slotIds.value = [...layoutState.slotIds]
  selectedId.value = channels.value[0]?.id ?? null
  playbackSeg.value = null
  viewMode.value = 'live'
  closeChannelDialog()
  await refreshInfo()
  await refreshStates()
  await refreshRecordings()
  await refreshDiskSpace()
  scheduleSyncPreviews()
}

async function onRepairChannel(id: string) {
  await api().stopPreview(id)
  const res = await api().startPreview(id)
  await refreshStates()
  status.value = res.ok ? `已修复预览：${id}` : `修复预览失败：${res.error}`
}

async function toggleChannelEnabled(id: string, enabled: boolean) {
  const ch = channels.value.find((c) => c.id === id)
  if (!ch) return
  try {
    channels.value = await api().upsertChannel({ ...ch, enabled })
    status.value = enabled ? `已启用 ${ch.name}` : `已停用 ${ch.name}`
    scheduleSyncPreviews()
    await refreshStates()
  } catch (e) {
    status.value = e instanceof Error ? e.message : '更新失败'
  }
}

async function onBatchEnable(ids: string[], enabled: boolean) {
  const patch = channels.value.filter((c) => ids.includes(c.id)).map((c) => ({ ...c, enabled }))
  if (!patch.length) return
  channels.value = await api().upsertChannels(patch)
  status.value = enabled ? `已启用 ${ids.length} 台` : `已停用 ${ids.length} 台`
  scheduleSyncPreviews()
  await refreshStates()
}

async function onBatchStart(ids: string[]) {
  const targets = channels.value.filter((c) => ids.includes(c.id) && c.enabled)
  let ok = 0
  for (const ch of targets) {
    const res = await api().startRecord(ch.id)
    if (res.ok) ok += 1
  }
  await refreshStates()
  const skipped = ids.length - targets.length
  status.value = skipped
    ? `批量开始录像 ${ok}/${targets.length}（跳过停用 ${skipped}）`
    : `批量开始录像 ${ok}/${ids.length}`
  void refreshRecordings()
}

async function onSave(channel: ChannelConfig) {
  try {
    const isNew = !!channelDraft.value
    if (isNew && channels.value.some((c) => c.id === channel.id)) {
      status.value = `ID 已存在：${channel.id}`
      return
    }
    channels.value = await api().upsertChannel(channel)
    selectedId.value = channel.id
    activeGroup.value = channelGroup(channel)
    ensureSlot(channel.id)
    closeChannelDialog()
    status.value = isNew ? `已添加 ${channel.name}` : `已保存 ${channel.name}`
    scheduleSyncPreviews()
    await refreshStates()
  } catch (e) {
    status.value = e instanceof Error ? e.message : '保存失败'
  }
}

async function copyChannelUrl(id: string) {
  const ch = channels.value.find((c) => c.id === id)
  if (!ch?.url) return
  try {
    await navigator.clipboard.writeText(ch.url)
    status.value = '已复制主码流 URL'
  } catch {
    status.value = '复制失败'
  }
}

async function onContextMenu(
  action: string,
  payload?: {
    channelId?: string
    group?: string
    slotIndex?: number
    channelIds?: string[]
    segmentId?: string
  },
) {
  const id = payload?.channelId
  const group = payload?.group
  const segmentId = payload?.segmentId

  switch (action) {
    case 'props':
      openChannelProps(id)
      break
    case 'add':
      startAdd()
      break
    case 'addInGroup':
      if (group) {
        activeGroup.value = group
        startAdd(group)
      } else startAdd()
      break
    case 'moveNewGroup': {
      const ids = payload?.channelIds?.length ? payload.channelIds : id ? [id] : []
      if (!ids.length) break
      const name = window.prompt('新分组名称')
      if (name == null) break
      const trimmed = name.trim()
      if (!trimmed) break
      try {
        if (!groupOrder.value.includes(trimmed) && trimmed !== DEFAULT_GROUP) {
          groupOrder.value = await api().createGroup(trimmed)
        }
        await onMoveToGroup(ids, trimmed)
      } catch (e) {
        status.value = e instanceof Error ? e.message : '移到新分组失败'
      }
      break
    }
    case 'manageGroups':
      showGroupsDialog.value = true
      break
    case 'scanDevices':
      openScanDialog()
      break
    case 'renameGroup': {
      if (!group || group === DEFAULT_GROUP) break
      const name = window.prompt('重命名分组', group)
      if (name == null) break
      const trimmed = name.trim()
      if (!trimmed || trimmed === group) break
      await onRenameGroup(group, trimmed)
      break
    }
    case 'dissolveGroup': {
      if (!group || group === DEFAULT_GROUP) break
      const count = channels.value.filter((c) => channelGroup(c) === group).length
      if (count === 0) {
        if (!window.confirm(`删除空分组「${group}」？`)) break
        await onDeleteGroup(group)
        break
      }
      if (!window.confirm(`解散分组「${group}」？通道将移到「${DEFAULT_GROUP}」。`)) break
      await onDissolveGroup(group)
      break
    }
    case 'start':
      if (id) await onStart(id)
      break
    case 'stop':
      if (id) await onStop(id)
      break
    case 'startGroup':
      if (group) await onStartGroup(group)
      break
    case 'stopGroup':
      if (group) await onStopGroup(group)
      break
    case 'previewStart':
      if (id) await onPreviewStart(id)
      break
    case 'previewStop':
      if (id) await onPreviewStop(id)
      break
    case 'probe':
      if (id) await onProbe(id)
      break
    case 'reveal': {
      const seg = segmentId
        ? (segments.value.find((s) => s.id === segmentId) ??
          savedClips.value.find((s) => s.id === segmentId))
        : null
      if (seg?.path) await api().revealItem(seg.path)
      else await onReveal(id)
      break
    }
    case 'revealAll':
      await onReveal()
      break
    case 'revealSnapshots':
      if (id) await api().revealSnapshots(id)
      else await api().revealSnapshots()
      break
    case 'revealSaved': {
      const seg = segmentId ? savedClips.value.find((s) => s.id === segmentId) : null
      if (seg?.path) await api().revealItem(seg.path)
      else if (id) await api().revealSavedClips(id)
      else await api().revealSavedClips()
      break
    }
    case 'saveClip':
      if (id) await onSaveClip(id)
      break
    case 'copyUrl':
      if (id) await copyChannelUrl(id)
      break
    case 'enable':
      if (id) await toggleChannelEnabled(id, true)
      break
    case 'disable':
      if (id) await toggleChannelEnabled(id, false)
      break
    case 'remove':
      if (id) {
        closeChannelDialog()
        await onRemove(id)
      }
      break
    case 'repairConfig':
      await onRepairConfig()
      break
    case 'repairChannel':
      if (id) await onRepairChannel(id)
      break
    case 'refresh':
      await refreshChannels()
      await refreshRecordings()
      status.value = '已刷新'
      break
    case 'openSettings':
      settingsInitialCat.value = 'appearance'
      showSettings.value = true
      break
    default:
      break
  }
}

async function onRenameChannel(id: string, name: string) {
  const ch = channels.value.find((c) => c.id === id)
  if (!ch) return
  const next = name.trim()
  if (!next || next === ch.name) return
  try {
    channels.value = await api().upsertChannel({ ...ch, name: next })
    status.value = `已重命名：${next}`
  } catch (e) {
    status.value = e instanceof Error ? e.message : '重命名失败'
  }
}

async function onMoveToGroup(ids: string[], group: string) {
  channels.value = await api().moveChannelsToGroup(ids, group)
  groupOrder.value = await api().getGroupOrder()
  activeGroup.value = group === DEFAULT_GROUP || !group.trim() ? DEFAULT_GROUP : group
  status.value = `已将 ${ids.length} 台设备移到「${activeGroup.value}」`
}

async function onMoveChannelsBefore(ids: string[], targetGroup: string, beforeId: string | null) {
  channels.value = await api().moveChannelsBefore(ids, targetGroup, beforeId)
  groupOrder.value = await api().getGroupOrder()
  activeGroup.value = targetGroup === DEFAULT_GROUP || !targetGroup.trim() ? DEFAULT_GROUP : targetGroup
  status.value = `已调整 ${ids.length} 台设备位置`
}

async function onMoveGroupBefore(group: string, beforeGroup: string | null) {
  groupOrder.value = await api().moveGroupBefore(group, beforeGroup)
  activeGroup.value = group
  status.value = `已调整分组「${group}」顺序`
}

async function onRenameGroup(from: string, to: string) {
  try {
    channels.value = await api().renameGroup(from, to)
    groupOrder.value = await api().getGroupOrder()
    activeGroup.value = to === DEFAULT_GROUP ? DEFAULT_GROUP : to
    status.value = `分组已重命名：${from} → ${to}`
  } catch (e) {
    status.value = e instanceof Error ? e.message : '重命名失败'
  }
}

async function onCreateGroup(name: string) {
  try {
    groupOrder.value = await api().createGroup(name)
    activeGroup.value = normalizeGroupName(name)
    status.value = `已创建分组「${normalizeGroupName(name)}」`
  } catch (e) {
    status.value = e instanceof Error ? e.message : '创建分组失败'
  }
}

async function onDeleteGroup(name: string) {
  try {
    groupOrder.value = await api().deleteGroup(name)
    if (activeGroup.value === name) activeGroup.value = DEFAULT_GROUP
    status.value = `已删除分组「${name}」`
  } catch (e) {
    status.value = e instanceof Error ? e.message : '删除分组失败'
  }
}

async function onDissolveGroup(name: string) {
  try {
    channels.value = await api().dissolveGroup(name)
    groupOrder.value = await api().getGroupOrder()
    activeGroup.value = DEFAULT_GROUP
    status.value = `已解散分组「${name}」`
  } catch (e) {
    status.value = e instanceof Error ? e.message : '解散分组失败'
  }
}

async function onBatchRemove(ids: string[]) {
  if (!ids.length) return
  if (!window.confirm(`确定删除选中的 ${ids.length} 台设备？`)) return
  closeChannelDialog()
  channels.value = await api().removeChannels(ids)
  const remove = new Set(ids)
  setSlotIds(slotIds.value.map((x) => (x && remove.has(x) ? null : x)))
  if (selectedId.value && remove.has(selectedId.value)) {
    selectedId.value = channels.value[0]?.id ?? null
  }
  status.value = `已删除 ${ids.length} 台设备`
  scheduleSyncPreviews()
  await refreshStates()
  await refreshRecordings()
}

async function onBatchStop(ids: string[]) {
  for (const id of ids) await api().stopRecord(id)
  await refreshStates()
  status.value = `已批量停止 ${ids.length} 台`
  void refreshRecordings()
}

async function onRemove(id: string) {
  const ch = channels.value.find((c) => c.id === id)
  if (!window.confirm(`确定删除通道「${ch?.name ?? id}」？`)) return
  channels.value = await api().removeChannel(id)
  setSlotIds(slotIds.value.map((x) => (x === id ? null : x)))
  if (selectedId.value === id) selectedId.value = channels.value[0]?.id ?? null
  status.value = '已删除通道'
  scheduleSyncPreviews()
  await refreshStates()
  await refreshRecordings()
}

async function onStart(id: string) {
  const res = await api().startRecord(id)
  await refreshStates()
  status.value = res.ok ? `开始录像：${id}` : `录像失败：${res.error}`
  void refreshRecordings()
}

async function onStop(id: string) {
  await api().stopRecord(id)
  await refreshStates()
  status.value = `已停止：${id}`
  void refreshRecordings()
}

async function onStopAll() {
  await api().stopAllRecords()
  await refreshStates()
  status.value = '已停止全部录像'
}

async function onClearLoopRecordings() {
  if (
    !window.confirm(
      '确定清空全部循环录像？\n\n• 将删除录像目录中的循环分段\n• 不会删除「已保存」片段\n• 正在写入的文件可能暂时无法删除\n\n此操作不可恢复。',
    )
  ) {
    return
  }
  try {
    const info = await api().clearAllLoopRecordings()
    diskSpace.value = info
    status.value = info?.lastAction?.message ?? '已清空循环录像'
    await refreshRecordings()
    await refreshDiskSpace()
  } catch (e) {
    status.value = e instanceof Error ? e.message : '清空失败'
  }
}

async function onStartGroup(group: string) {
  const res = await api().startRecordGroup(group)
  await refreshStates()
  status.value = res.ok
    ? `分组「${group}」已开始录像 ${res.started}/${res.total}`
    : `分组「${group}」部分失败：${res.errors[0] ?? '未知错误'}（${res.started}/${res.total}）`
  void refreshRecordings()
}

async function onStopGroup(group: string) {
  await api().stopRecordGroup(group)
  await refreshStates()
  status.value = `分组「${group}」已停止录像`
  void refreshRecordings()
}

async function onReveal(id?: string) {
  await api().revealRecordings(id)
}

async function onProbe(id: string) {
  probing.value = true
  probeMessage.value = '正在探测…'
  try {
    const res = await api().probeChannel(id)
    probeMessage.value = res.ok ? res.summary : `失败：${res.error}`
    status.value = probeMessage.value
  } finally {
    probing.value = false
  }
}

async function onPreviewStart(id: string) {
  ensureSlot(id)
  const res = await api().startPreview(id)
  await refreshStates()
  status.value = res.ok ? `预览中：${id}` : `预览失败：${res.error}`
}

async function onPreviewStop(id: string) {
  await api().stopPreview(id)
  await refreshStates()
  status.value = `已停止预览：${id}`
}

async function onSnapshot(channelId: string, dataUrl: string) {
  const res = await api().saveSnapshot(channelId, dataUrl)
  status.value = res.ok ? `截图已保存：${res.path}` : `截图失败：${res.error}`
}

async function onSaveClip(channelId?: string) {
  const id = channelId ?? selectedId.value
  if (!id) {
    status.value = '请先选择通道'
    return
  }
  if (channelId && channelId !== selectedId.value) selectedId.value = channelId
  if (!layout.showTimeline) setShowTimeline(true)
  await refreshRecordings()
  await nextTick()
  await nextTick()
  const panel = timelineRef.value
  if (!panel?.beginSaveSelection) {
    status.value = '时间轴未就绪，请再试一次'
    return
  }
  const res = panel.beginSaveSelection()
  status.value = res.ok
    ? `已默认选中最近约 ${Math.round((appSettings.value.savedClipDurationSec || 600) / 60)} 分钟，可拖动调整后点「确认保存」`
    : res.error
}

async function onExportRange(payload: {
  channelId: string
  startMs: number
  endMs: number
  pickPath?: boolean
}) {
  if (exportBusy.value) return
  exportBusy.value = true
  status.value = '正在裁切拼接片段…'
  try {
    const res = await api().exportClipRange(payload)
    if (res.ok) {
      status.value = res.message
      timelineRef.value?.clearSelection?.()
      timelineRef.value?.setSelectMode?.(false)
      timelineRef.value?.setSource?.('saved')
      await refreshRecordings()
      await refreshDiskSpace()
    } else if (!res.canceled) {
      status.value = res.error
    } else {
      status.value = '已取消导出'
    }
  } finally {
    exportBusy.value = false
  }
}

async function onDeleteSaved(seg: RecordingSegment) {
  if (!seg.protected) return
  if (!window.confirm(`删除已保存片段「${seg.fileName}」？此操作不可恢复。`)) return
  const res = await api().deleteSavedClip(seg.id)
  status.value = res.ok ? `已删除受保护片段：${seg.fileName}` : res.error
  await refreshRecordings()
  await refreshDiskSpace()
}

async function onSettingsSaved(s: AppSettings) {
  appSettings.value = s
  applyUiTheme(s.uiTheme)
  await refreshInfo()
  await refreshDiskSpace()
  status.value = `设置已保存 · 录像目录 ${info.value?.recordingsPath ?? ''}`
}

async function setUiTheme(theme: UiTheme) {
  applyUiTheme(theme)
  try {
    const next = await api().setSettings({ uiTheme: theme })
    appSettings.value = next
  } catch (e) {
    status.value = e instanceof Error ? e.message : '主题切换失败'
  }
}

let systemThemeMql: MediaQueryList | null = null
function onSystemThemeChange() {
  if (appSettings.value.uiTheme === 'system') applyUiTheme('system')
}

async function refreshDiskSpace() {
  diskSpace.value = await api().getDiskSpace()
}

function onStorageAction(action: StorageAction) {
  status.value = action.message
  void refreshStates()
  void refreshRecordings()
  void refreshDiskSpace()
}

function onStorageChanged(info: DiskSpaceInfo) {
  diskSpace.value = info
}

function onGlobalKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return
  }
  if (showSettings.value || showChannelDialog.value) return

  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    startAdd()
    return
  }
  if (mod && e.key === ',') {
    e.preventDefault()
    settingsInitialCat.value = 'appearance'
    showSettings.value = true
    return
  }
  if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    setShowExplorer(!layout.showExplorer)
    return
  }
  if (mod && e.key.toLowerCase() === 't') {
    e.preventDefault()
    setShowTimeline(!layout.showTimeline)
    return
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void onSaveClip()
    return
  }
  if (mod && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    if (!selectedId.value) return
    const st = states.value[selectedId.value]
    if (st?.recording === 'recording') void onStop(selectedId.value)
    else void onStart(selectedId.value)
    return
  }
  if (mod && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault()
    const map = { '1': 1, '2': 4, '3': 9, '4': 16 } as const
    setMosaic(map[e.key as '1' | '2' | '3' | '4'])
    return
  }
  if (e.key === 'F5') {
    e.preventDefault()
    void refreshChannels()
    void refreshRecordings()
    void refreshDiskSpace()
    status.value = '已刷新'
    return
  }
  if (e.key === 'Delete' && selectedId.value) {
    e.preventDefault()
    void onRemove(selectedId.value)
  }
}

onMounted(async () => {
  const saved = sanitizeUiLayout(await api().getLayout())
  Object.assign(layout, saved)
  slotIds.value = [...saved.slotIds]
  appSettings.value = await api().getSettings()
  applyUiTheme(appSettings.value.uiTheme)
  systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)')
  systemThemeMql.addEventListener('change', onSystemThemeChange)
  await refreshInfo()
  await refreshChannels()
  await refreshStates()
  await refreshRecordings()
  await refreshDiskSpace()
  scheduleSyncPreviews()
  if (!info.value?.ffmpegOk) {
    status.value = '未检测到 FFmpeg：请在设置中指定路径，或加入 PATH'
  } else if (info.value.mediaBaseUrl) {
    status.value = `就绪 · 录像 ${info.value.recordingsPath}`
  }
  pollTimer = setInterval(() => {
    void refreshStates()
    if (recordingCount.value > 0) void refreshRecordings({ silent: true })
  }, 2000)
  diskTimer = setInterval(() => {
    void refreshDiskSpace()
  }, 30_000)
  unsubStorageAction = api().onStorageAction(onStorageAction)
  unsubStorageChanged = api().onStorageChanged(onStorageChanged)
  unsubWindowVisibility = api().onWindowVisibility((p) => {
    void onWindowVisibility(p)
  })
  window.addEventListener('keydown', onGlobalKey)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (diskTimer) clearInterval(diskTimer)
  if (layoutTimer) clearTimeout(layoutTimer)
  if (syncTimer) clearTimeout(syncTimer)
  unsubStorageAction?.()
  unsubStorageChanged?.()
  unsubWindowVisibility?.()
  systemThemeMql?.removeEventListener('change', onSystemThemeChange)
  window.removeEventListener('keydown', onGlobalKey)
})

watch(
  () => layout.mosaic,
  () => scheduleSaveLayout(),
)

watch(selectedId, () => {
  void refreshRecordings()
  if (viewMode.value === 'playback') playbackSeg.value = null
})
</script>

<template>
  <div
    class="shell"
    :class="{ 'config-drop': configDropActive }"
    @contextmenu.prevent
    @dragenter="onShellDragEnter"
    @dragover="onShellDragOver"
    @dragleave="onShellDragLeave"
    @drop="onShellDrop"
  >
    <ContextMenuHost />
    <TitleBar
      :title="selected?.name ?? '未选择通道'"
      :mosaic="layout.mosaic"
      :recording-count="recordingCount"
      :ffmpeg-ok="!!info?.ffmpegOk"
      :groups="groups"
      :active-group="activeGroup"
      :show-explorer="layout.showExplorer"
      :show-timeline="layout.showTimeline"
      :view-mode="viewMode"
      :ui-theme="appSettings.uiTheme"
      @mosaic="setMosaic"
      @update:active-group="(g) => (activeGroup = g)"
      @update:show-explorer="setShowExplorer"
      @update:show-timeline="setShowTimeline"
      @update:view-mode="(m) => (m === 'playback' ? enterPlayback() : exitPlayback())"
      @update:ui-theme="setUiTheme"
      @start-group="onStartGroup"
      @stop-group="onStopGroup"
      @stop-all="onStopAll"
      @clear-loop-recordings="onClearLoopRecordings"
      @reveal="() => onReveal()"
      @reveal-snapshots="() => api().revealSnapshots()"
      @reveal-saved="() => api().revealSavedClips()"
      @export-config="onExportConfig"
      @import-config="onImportConfig"
      @open-settings="
        () => {
          settingsInitialCat = 'appearance'
          showSettings = true
        }
      "
      @open-about="
        () => {
          settingsInitialCat = 'about'
          showSettings = true
        }
      "
      @add-channel="startAdd"
      @scan-devices="openScanDialog"
      @manage-groups="showGroupsDialog = true"
      @repair-config="onRepairConfig"
      @open-dev-tools="() => void api().toggleDevTools()"
      @minimize="() => api().windowMinimize()"
      @maximize="() => api().windowMaximize()"
      @close="() => api().windowClose()"
    />

    <SettingsView
      v-if="showSettings"
      :key="settingsInitialCat"
      :initial-cat="settingsInitialCat"
      :current-theme="appSettings.uiTheme"
      @close="showSettings = false"
      @saved="onSettingsSaved"
      @export-config="
        () => {
          showSettings = false
          void onExportConfig()
        }
      "
      @import-config="
        () => {
          showSettings = false
          void onImportConfig()
        }
      "
    />

    <DeviceScanDialog
      v-if="showScanDialog"
      :existing-ids="channels.map((c) => c.id)"
      :default-group="activeGroup"
      :default-segment-time-sec="appSettings.defaultSegmentTimeSec"
      :default-rtsp-transport="appSettings.defaultRtspTransport"
      :group-suggestions="groups"
      :group-order="groupOrder"
      @close="showScanDialog = false"
      @add="onScanAdd"
    />

    <ConfigTransferDialog
      v-if="configWizard"
      :mode="configWizard"
      :initial-path="configImportPath"
      @close="closeConfigWizard"
      @done="onConfigWizardDone"
    />

    <div v-if="configDropActive" class="config-drop-banner" aria-hidden="true">
      松开以导入配置（.json）
    </div>

    <GroupsDialog
      v-if="showGroupsDialog"
      :channels="channels"
      :group-order="groupOrder"
      @close="showGroupsDialog = false"
      @create="onCreateGroup"
      @rename="onRenameGroup"
      @dissolve="onDissolveGroup"
      @remove="onDeleteGroup"
      @move-before="onMoveGroupBefore"
    />

    <ChannelDialog
      v-if="showChannelDialog && dialogChannel"
      :channel="dialogChannel"
      :state="dialogState"
      :is-new="!!channelDraft"
      :group-suggestions="groups"
      @close="closeChannelDialog"
      @save="onSave"
    />

    <div class="body">
      <template v-if="layout.showExplorer">
        <DeviceTree
          class="explorer"
          :style="{ width: `${layout.panelSizes.explorer}px` }"
          :channels="channels"
          :states="states"
          :selected-id="selectedId"
          :active-group="activeGroup"
          :group-order="groupOrder"
          @select="onSelect"
          @add="startAdd"
          @manage-groups="showGroupsDialog = true"
          @scan-devices="openScanDialog"
          @update:active-group="(g) => (activeGroup = g)"
          @menu="onContextMenu"
          @move-to-group="onMoveToGroup"
          @move-channels-before="onMoveChannelsBefore"
          @move-group-before="onMoveGroupBefore"
          @batch-enable="onBatchEnable"
          @batch-remove="onBatchRemove"
          @batch-start="onBatchStart"
          @batch-stop="onBatchStop"
          @rename="onRenameChannel"
        />
        <ResizeHandle
          axis="horizontal"
          edge="end"
          :value="layout.panelSizes.explorer"
          :min="PANEL_LIMITS.explorer.min"
          :max="PANEL_LIMITS.explorer.max"
          @update:value="(v) => setPanelSize('explorer', v)"
        />
      </template>

      <div class="center">
        <PlaybackView
          v-if="viewMode === 'playback'"
          :channel-name="selected?.name ?? null"
          :channel-id="selectedId"
          :source="timelineSource"
          :playlist="playbackPlaylist"
          :rate="playbackRate"
          :continuous="playbackContinuous"
          :scrub-wall-ms="playbackScrubWallMs"
          :scrub-nonce="playbackScrubNonce"
          :play-id="playbackPlayId"
          :play-nonce="playbackPlayNonce"
          :suspended="!windowVisible"
          @exit="exitPlayback"
          @follow="onPlaybackFollow"
          @segment="onPlaybackSegment"
          @playlist-ended="onPlaylistEnded"
          @busy="(on) => (playbackBusy = on)"
          @update:rate="(r) => (playbackRate = r)"
        />
        <MosaicView
          v-else
          :mosaic="layout.mosaic"
          :channels="channels"
          :states="states"
          :selected-id="selectedId"
          :slot-ids="slotIds"
          :playback-suspended="!windowVisible"
          @select="onSelect"
          @assign="onAssignSlot"
          @assign-group="onAssignGroup"
          @swap="onSwapSlots"
          @snapshot="onSnapshot"
          @save-clip="onSaveClip"
          @enter-playback="() => enterPlayback()"
          @menu="onContextMenu"
        />
        <template v-if="layout.showTimeline || viewMode === 'playback'">
          <ResizeHandle
            axis="vertical"
            edge="start"
            :value="layout.panelSizes.timeline"
            :min="PANEL_LIMITS.timeline.min"
            :max="PANEL_LIMITS.timeline.max"
            @update:value="(v) => setPanelSize('timeline', v)"
          />
          <TimelinePanel
            ref="timelineRef"
            :height="layout.panelSizes.timeline"
            :channel-id="selectedId"
            :channel-name="selected?.name ?? null"
            :segments="segments"
            :saved-clips="savedClips"
            :loading="segmentsLoading"
            :scrub-locked="viewMode === 'playback' && playbackBusy"
            :saved-clip-minutes="Math.round((appSettings.savedClipDurationSec || 600) / 60)"
            :playing-id="playbackSeg?.id ?? null"
            :active="viewMode === 'playback'"
            :export-busy="exportBusy"
            :follow-ms="viewMode === 'playback' ? playbackFollowMs : null"
            :follow-live-edge="timelineFollowLiveEdge"
            @refresh="refreshRecordings"
            @save-clip="() => onSaveClip()"
            @delete-saved="onDeleteSaved"
            @activate="() => enterPlayback()"
            @play="onPlaybackPlay"
            @scrub="onTimelineScrub"
            @export-range="onExportRange"
            @update:rate="(r) => (playbackRate = r)"
            @update:source="(s) => (timelineSource = s)"
            @update:continuous="(v) => (playbackContinuous = v)"
            @menu="onContextMenu"
          />
        </template>
      </div>
    </div>

    <StatusBar
      :message="status"
      :channel-count="channels.length"
      :recording-count="recordingCount"
      :data-root="info?.recordingsPath ?? info?.dataRoot ?? ''"
      :app-version="info?.version"
      :disk-label="diskSpace ? formatGbLabel(diskSpace.freeBytes) : undefined"
      :disk-used-label="diskSpace ? formatGbLabel(diskSpace.recordingsBytes) : undefined"
      :disk-saved-label="
        diskSpace && diskSpace.savedClipsBytes > 0
          ? formatGbLabel(diskSpace.savedClipsBytes)
          : undefined
      "
      :disk-remain-label="
        diskSpace?.estimatedRemainSec != null
          ? formatDurationLabel(diskSpace.estimatedRemainSec)
          : undefined
      "
      :disk-level="diskSpace?.level ?? 'ok'"
      :disk-blocked="!!diskSpace?.recordingBlocked"
      :retention-fit="diskSpace?.retentionFit"
      :retention-hint="
        diskSpace && diskSpace.retentionFit === false && diskSpace.retentionNeedBytes != null
          ? `按当前码流，保留 ${diskSpace.retentionDays} 天约需 ${formatGbLabel(diskSpace.retentionNeedBytes)}，剩余 ${formatGbLabel(diskSpace.freeBytes)}`
          : undefined
      "
    />
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  position: relative;
}
.shell.config-drop::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 9200;
  pointer-events: none;
  border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-sizing: border-box;
}
.config-drop-banner {
  position: absolute;
  left: 50%;
  top: 48%;
  transform: translate(-50%, -50%);
  z-index: 9201;
  pointer-events: none;
  padding: 12px 18px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-weight: 700;
  font-size: 14px;
  box-shadow: var(--shadow);
}
.body {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.explorer {
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.center {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #1a2332;
  overflow: hidden;
}
</style>
