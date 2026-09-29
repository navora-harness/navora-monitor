<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { ChannelConfig, ChannelRuntimeState, RecordingSegment } from '@shared/types'
import { DEFAULT_GROUP, channelGroup, listGroups } from '@shared/groups'
import {
  PANEL_LIMITS,
  emptySlotIds,
  sanitizeUiLayout,
  type UiLayoutState,
} from '@shared/panel-sizes'
import { REMOTE_USERNAME } from '@shared/password'
import TitleBar from '../components/TitleBar.vue'
import DeviceTree from '../components/DeviceTree.vue'
import RemoteLiveGrid from './RemoteLiveGrid.vue'
import PlaybackView from '../components/PlaybackView.vue'
import TimelinePanel from '../components/TimelinePanel.vue'
import StatusBar from '../components/StatusBar.vue'
import ResizeHandle from '../components/ResizeHandle.vue'
import ContextMenuHost from '../components/ContextMenuHost.vue'
import { applyUiTheme, type UiTheme } from '../theme'
import {
  AuthError,
  fetchBootstrap,
  fetchRecordings,
  fetchRemoteStatus,
  fetchSavedClips,
  fetchStates,
  getStoredToken,
  login,
  logout,
  syncPreviews,
  withMediaAuth,
  withSegmentMediaAuth,
  type RemoteAppMeta,
} from './api'
import { buildRemoteLivePreviewUrl } from '../media-url'
import { defaultRemoteLayout, loadRemoteLayout, saveRemoteLayout } from './layout-store'
import {
  APP_COPYRIGHT,
  APP_HOMEPAGE,
  APP_LICENSE,
  APP_LICENSE_NOTE,
  APP_NAME,
} from '@shared/app-meta'
import { OPEN_SOURCE_CREDITS } from '@shared/open-source-credits'
import { NM_UI_VERSION } from '../ui-version'

const authed = ref(!!getStoredToken())
const username = ref(REMOTE_USERNAME)
const password = ref('')
const loginError = ref('')
const loggingIn = ref(false)
const showAbout = ref(false)

const appMeta = ref<RemoteAppMeta>({
  name: APP_NAME,
  version: '',
  license: APP_LICENSE,
  copyright: APP_COPYRIGHT,
  homepage: APP_HOMEPAGE,
  licenseNote: APP_LICENSE_NOTE,
})

const channels = ref<ChannelConfig[]>([])
const groupOrder = ref<string[]>([])
const states = ref<Record<string, ChannelRuntimeState>>({})
const selectedId = ref<string | null>(null)
const slotIds = ref<(string | null)[]>(emptySlotIds())
const activeGroup = ref(DEFAULT_GROUP)
const uiTheme = ref<UiTheme>('system')
const status = ref('就绪')
const loading = ref(false)
const mobile = ref(false)
const mobileDrawer = ref(false)
const drawerDragX = ref(0)
const drawerDragging = ref(false)
let drawerSwipe: {
  pointerId: number
  startX: number
  startY: number
  width: number
  tracking: boolean
  decided: boolean
} | null = null

const viewMode = ref<'live' | 'playback'>('live')
const segments = ref<RecordingSegment[]>([])
const savedClips = ref<RecordingSegment[]>([])
const segmentsLoading = ref(false)
const playbackSeg = ref<RecordingSegment | null>(null)
const playbackRate = ref(1)
const playbackScrubWallMs = ref<number | null>(null)
const playbackScrubNonce = ref(0)
const playbackPlayId = ref<string | null>(null)
const playbackPlayNonce = ref(0)
const playbackFollowMs = ref<number | null>(null)
const playbackContinuous = ref(true)
const playbackBusy = ref(false)
const timelineSource = ref<'loop' | 'saved'>('loop')
const playbackPlaylist = computed(() =>
  timelineSource.value === 'saved' ? savedClips.value : segments.value,
)
const timelineRef = ref<InstanceType<typeof TimelinePanel> | null>(null)
/** Reactive media auth for PlaybackView (must not call getStoredToken() only once in template). */
const mediaAuthToken = computed(() => (authed.value ? getStoredToken() : null))
const mediaBaseUrl = computed(() =>
  typeof location !== 'undefined' ? location.origin : null,
)
/** Taller scrub chrome on phone; scales with viewport, leaves most space for video. */
const mobileTimelineHeight = computed(() => {
  if (typeof window === 'undefined') return 196
  const vh = window.innerHeight || 700
  // Two-row head + tappable track; extra room for iOS home-indicator padding.
  const base = Math.min(220, Math.max(168, vh * 0.27))
  return Math.round(base + 28)
})

const layout = reactive<UiLayoutState>(sanitizeUiLayout(defaultRemoteLayout()))
let layoutTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null
let mq: MediaQueryList | null = null

const groups = computed(() => listGroups(channels.value, groupOrder.value))
const layoutMode = computed<'grid' | 'scroll'>(() => (mobile.value ? 'scroll' : 'grid'))
const recordingCount = computed(
  () => Object.values(states.value).filter((s) => s.recording === 'recording').length,
)
const timelineFollowLiveEdge = computed(() => {
  if (viewMode.value !== 'live') return false
  if (!layout.showTimeline) return false
  const ids = slotIds.value.filter((x): x is string => !!x).slice(0, layout.mosaic)
  return ids.some((id) => {
    const st = states.value[id]
    return st?.preview === 'live' || st?.preview === 'starting'
  })
})
const selected = computed(() => channels.value.find((c) => c.id === selectedId.value) ?? null)
const showTimelinePanel = computed(
  () => layout.showTimeline || viewMode.value === 'playback',
)

const channelsInGroup = computed(() => {
  const g = activeGroup.value
  return channels.value.filter((c) => channelGroup(c) === g && c.enabled)
})

function applyStates(list: ChannelRuntimeState[]) {
  const next: Record<string, ChannelRuntimeState> = { ...states.value }
  for (const s of list) {
    next[s.id] = {
      ...s,
      previewUrl: withMediaAuth(s.previewUrl),
    }
  }
  states.value = next
}

function activeSlotIds(): string[] {
  return slotIds.value.filter((x): x is string => !!x).slice(0, layout.mosaic)
}

/** Absolute live.ts URLs for every slotted channel — drives remote players. */
const liveSrcById = computed(() => {
  const out: Record<string, string> = {}
  if (!authed.value || viewMode.value !== 'live') return out
  let ids = activeSlotIds()
  // Slots empty but we have channels → still build URLs so <video> can appear after fill.
  if (!ids.length) {
    ids = channels.value
      .filter((c) => c.enabled)
      .map((c) => c.id)
      .slice(0, layout.mosaic)
  }
  for (const id of ids) {
    const url = buildRemoteLivePreviewUrl(id)
    if (url) out[id] = url
  }
  return out
})

function setSlotIds(next: (string | null)[]) {
  const padded = emptySlotIds()
  for (let i = 0; i < padded.length; i++) padded[i] = next[i] ?? null
  slotIds.value = padded
  layout.slotIds = [...padded]
  schedulePersist()
}

function schedulePersist() {
  if (layoutTimer) clearTimeout(layoutTimer)
  layoutTimer = setTimeout(() => {
    saveRemoteLayout({
      ...sanitizeUiLayout(layout),
      showTimeline: layout.showTimeline,
      activeGroup: activeGroup.value,
      uiTheme: uiTheme.value,
      selectedId: selectedId.value,
    })
  }, 250)
}

function restoreLocalLayout() {
  const saved = loadRemoteLayout()
  Object.assign(layout, sanitizeUiLayout(saved))
  slotIds.value = [...saved.slotIds]
  activeGroup.value = saved.activeGroup
  selectedId.value = saved.selectedId
  uiTheme.value = saved.uiTheme
  applyUiTheme(saved.uiTheme)
}

function fillSlotsFromGroup() {
  // Bootstrap / empty wall: fill current mosaic size only (no auto-expand).
  let ids = channelsInGroup.value.map((c) => c.id).slice(0, layout.mosaic)
  // Group empty → fall back to any enabled channel so remote always has something to play.
  if (!ids.length) {
    ids = channels.value
      .filter((c) => c.enabled)
      .map((c) => c.id)
      .slice(0, layout.mosaic)
  }
  const slots = emptySlotIds()
  for (let i = 0; i < layout.mosaic; i++) slots[i] = ids[i] ?? null
  setSlotIds(slots)
  if (!selectedId.value && ids[0]) selectedId.value = ids[0]
}

function mosaicForCount(n: number): 1 | 4 | 9 | 16 {
  if (n <= 1) return 1
  if (n <= 4) return 4
  if (n <= 9) return 9
  return 16
}

/** Drag group onto mosaic: fill empty cells; expand grid if needed. */
function fillGroupIntoEmptySlots(channelIds: string[]) {
  const unique = [...new Set(channelIds)].filter((id) => channels.value.some((c) => c.id === id))
  if (!unique.length) return

  const next = [...slotIds.value]
  const onWall = new Set(next.filter((x): x is string => !!x))
  const queue = unique.filter((id) => !onWall.has(id))
  if (!queue.length) {
    status.value = '分组通道已在宫格中'
    const first = unique.find((id) => onWall.has(id))
    if (first) selectedId.value = first
    return
  }

  let mosaic = layout.mosaic
  let placed = 0
  const fillEmpties = () => {
    for (let i = 0; i < mosaic; i++) {
      if (next[i]) continue
      const id = queue.shift()
      if (!id) break
      next[i] = id
      placed += 1
    }
  }
  fillEmpties()
  while (queue.length) {
    const occupied = next.filter((x): x is string => !!x).length
    const need = Math.min(16, occupied + queue.length)
    const grown = mosaicForCount(need)
    if (grown <= mosaic) break
    mosaic = grown
    layout.mosaic = mosaic
    fillEmpties()
  }

  setSlotIds(next)
  const focus = next.find((x) => x && unique.includes(x)) ?? unique[0] ?? null
  if (focus) {
    selectedId.value = focus
    const ch = channels.value.find((c) => c.id === focus)
    if (ch) activeGroup.value = channelGroup(ch)
  }
  schedulePersist()
  const left = queue.length
  status.value = left
    ? `已填入空位 ${placed} 路（宫格已满，剩余 ${left} 路未放入）`
    : `已填入空位 ${placed} 路（${layout.mosaic} 宫格）`
  scheduleSync()
}

function onAssignGroup(ids: string[]) {
  fillGroupIntoEmptySlots(ids)
}

function replaceWallWithGroup(ids: string[]) {
  const unique = [...new Set(ids)].filter((id) => channels.value.some((c) => c.id === id))
  if (!unique.length) return
  const mosaic = mosaicForCount(unique.length)
  layout.mosaic = mosaic
  const next = emptySlotIds()
  for (let i = 0; i < mosaic; i++) next[i] = unique[i] ?? null
  setSlotIds(next)
  if (unique[0]) {
    selectedId.value = unique[0]
    const ch = channels.value.find((c) => c.id === unique[0])
    if (ch) activeGroup.value = channelGroup(ch)
  }
  schedulePersist()
  status.value = `已展示分组 ${unique.length} 路（${mosaic} 宫格）`
  scheduleSync()
}

async function refreshPreviews() {
  if (!authed.value) return
  try {
    const res = await syncPreviews(activeSlotIds())
    applyStates(res.states)
    if (status.value.startsWith('同步失败')) status.value = '就绪'
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
    status.value = e instanceof Error ? e.message : '同步失败'
  }
}

/** Refresh badges without re-POSTing demand (avoids tearing down the player). */
async function refreshStatesOnly() {
  if (!authed.value) return
  try {
    const res = await fetchStates()
    applyStates(res.states)
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
  }
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    void refreshPreviews()
  }, 200)
}

async function bootstrap() {
  loading.value = true
  status.value = '加载中…'
  try {
    const data = await fetchBootstrap()
    channels.value = data.channels
    groupOrder.value = data.groupOrder
    applyStates(data.states)
    if (data.app) appMeta.value = { ...appMeta.value, ...data.app }
    // Prefer local theme; fall back to host theme once
    if (!localStorage.getItem('navora-remote-layout-v1') && data.uiTheme) {
      uiTheme.value = data.uiTheme as UiTheme
      applyUiTheme(uiTheme.value)
    }
    const alive = new Set(channels.value.map((c) => c.id))
    setSlotIds(slotIds.value.map((x) => (x && alive.has(x) ? x : null)))
    if (selectedId.value && !alive.has(selectedId.value)) selectedId.value = null
    if (!groups.value.includes(activeGroup.value)) {
      activeGroup.value = groups.value[0] ?? DEFAULT_GROUP
      schedulePersist()
    }
    // Always (re)fill when wall has no live cells — remote must show video tags.
    if (activeSlotIds().length === 0) fillSlotsFromGroup()
    scheduleSync()
    authed.value = true
    const n = activeSlotIds().length
    status.value =
      n > 0
        ? `就绪 · 宫格 ${n} 路 · live ${Object.keys(liveSrcById.value).length}`
        : `就绪 · 宫格为空（通道 ${channels.value.length}）`
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
    status.value = e instanceof Error ? e.message : '加载失败'
    authed.value = false
  } finally {
    loading.value = false
  }
}

async function doLogin() {
  loginError.value = ''
  loggingIn.value = true
  try {
    await login(username.value, password.value)
    password.value = ''
    await bootstrap()
  } catch (e) {
    loginError.value = e instanceof Error ? e.message : '登录失败'
    authed.value = false
  } finally {
    loggingIn.value = false
  }
}

async function doLogout() {
  stopPolling()
  await logout()
  authed.value = false
  channels.value = []
  states.value = {}
  segments.value = []
  savedClips.value = []
  playbackSeg.value = null
  viewMode.value = 'live'
  status.value = '已退出'
}

async function refreshRecordings(opts?: { silent?: boolean }) {
  if (!authed.value) return
  if (!opts?.silent) segmentsLoading.value = true
  try {
    const id = selectedId.value
    const [loop, saved] = await Promise.all([fetchRecordings(id), fetchSavedClips(id)])
    segments.value = (loop.segments ?? []).map(withSegmentMediaAuth)
    savedClips.value = (saved.segments ?? []).map(withSegmentMediaAuth)
  } catch (e) {
    if (e instanceof AuthError) {
      authed.value = false
      return
    }
    status.value = e instanceof Error ? e.message : '加载录像失败'
  } finally {
    if (!opts?.silent) segmentsLoading.value = false
  }
}

function enterPlayback() {
  viewMode.value = 'playback'
  if (!layout.showTimeline) {
    layout.showTimeline = true
    schedulePersist()
  }
  void refreshRecordings()
  // Free host preview bandwidth while browsing recordings
  void syncPreviews([]).then((res) => applyStates(res.states)).catch(() => {})
  status.value = '回放模式'
}

function exitPlayback() {
  viewMode.value = 'live'
  playbackSeg.value = null
  playbackScrubWallMs.value = null
  playbackPlayId.value = null
  playbackFollowMs.value = null
  playbackBusy.value = false
  scheduleSync()
  status.value = '实时预览'
}

function setViewMode(mode: 'live' | 'playback') {
  if (mode === 'playback') enterPlayback()
  else exitPlayback()
}

function setShowTimeline(v: boolean) {
  // Playback always shows the timeline; don't persist a false that hides it on exit.
  if (viewMode.value === 'playback' && !v) return
  layout.showTimeline = v
  schedulePersist()
  if (v) void refreshRecordings()
}

function setPanelTimeline(v: number) {
  layout.panelSizes = { ...layout.panelSizes, timeline: v }
  schedulePersist()
}

function onPlaybackPlay(seg: RecordingSegment) {
  if (seg.protected) timelineSource.value = 'saved'
  else timelineSource.value = 'loop'
  playbackPlayId.value = seg.id
  playbackPlayNonce.value += 1
  playbackFollowMs.value = seg.startMs ?? seg.mtimeMs
  if (viewMode.value !== 'playback') enterPlayback()
}

function onTimelineScrub(payload: {
  atMs: number
  segment: RecordingSegment | null
  seekSec: number
}) {
  if (playbackBusy.value) return
  if (viewMode.value !== 'playback') enterPlayback()
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

function hostOnly(msg = '请在主机 Navora Monitor 中操作') {
  status.value = msg
}

function placeOnSlot(id: string, slotIndex: number) {
  const next = [...slotIds.value]
  while (next.length <= slotIndex) next.push(null)
  if (next[slotIndex] === id) return
  const from = next.findIndex((x) => x === id)
  if (from >= 0 && from !== slotIndex) next[from] = next[slotIndex] ?? null
  next[slotIndex] = id
  setSlotIds(next)
}

function onSelect(id: string) {
  selectedId.value = id
  schedulePersist()
  if (mobile.value) mobileDrawer.value = false
  if (layout.mosaic === 1) {
    placeOnSlot(id, 0)
  } else {
    const idx = slotIds.value.findIndex((x) => x === id)
    if (idx < 0) {
      const empty = slotIds.value.findIndex((x, i) => i < layout.mosaic && !x)
      const next = [...slotIds.value]
      if (empty >= 0) next[empty] = id
      else next[0] = id
      setSlotIds(next)
    }
  }
  if (viewMode.value === 'playback') void refreshRecordings()
}

function onAssign(slotIndex: number, id: string | null) {
  const next = [...slotIds.value]
  if (!id) {
    next[slotIndex] = null
  } else {
    const from = next.findIndex((x) => x === id)
    if (from >= 0 && from !== slotIndex) {
      next[from] = next[slotIndex] ?? null
      next[slotIndex] = id
    } else {
      next[slotIndex] = id
    }
  }
  setSlotIds(next)
  if (id) {
    selectedId.value = id
    schedulePersist()
  }
}

function onSwap(from: number, to: number) {
  const next = [...slotIds.value]
  const a = next[from]
  next[from] = next[to] ?? null
  next[to] = a ?? null
  setSlotIds(next)
}

function setMosaic(n: 1 | 4 | 9 | 16) {
  layout.mosaic = n
  const kept = activeSlotIds().slice(0, n)
  const next = emptySlotIds()
  for (let i = 0; i < n; i++) next[i] = kept[i] ?? null
  if (mobile.value && kept.length < n) {
    const pool = channelsInGroup.value.map((c) => c.id)
    let pi = 0
    for (let i = 0; i < n; i++) {
      if (next[i]) continue
      while (pi < pool.length && kept.includes(pool[pi]!)) pi++
      if (pi < pool.length) next[i] = pool[pi++]!
    }
  }
  setSlotIds(next)
  schedulePersist()
}

function setShowExplorer(v: boolean) {
  layout.showExplorer = v
  schedulePersist()
  if (mobile.value) {
    mobileDrawer.value = v
    if (!v) {
      drawerDragX.value = 0
      drawerDragging.value = false
      drawerSwipe = null
    }
  }
}

function onDrawerPointerDown(e: PointerEvent) {
  if (!mobile.value || !mobileDrawer.value) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  const t = e.target as HTMLElement | null
  if (t?.closest('input, textarea, button, a, select, [contenteditable="true"]')) return
  const panel = e.currentTarget as HTMLElement
  drawerSwipe = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    width: panel.getBoundingClientRect().width || 280,
    tracking: false,
    decided: false,
  }
  drawerDragging.value = false
  drawerDragX.value = 0
  try {
    panel.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
}

function onDrawerPointerMove(e: PointerEvent) {
  const s = drawerSwipe
  if (!s || e.pointerId !== s.pointerId) return
  const dx = e.clientX - s.startX
  const dy = e.clientY - s.startY
  if (!s.decided) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
    s.decided = true
    if (dx >= -8 || Math.abs(dx) <= Math.abs(dy) * 1.15) {
      drawerSwipe = null
      drawerDragging.value = false
      drawerDragX.value = 0
      return
    }
    s.tracking = true
    drawerDragging.value = true
  }
  if (!s.tracking) return
  e.preventDefault()
  drawerDragX.value = Math.min(0, dx)
}

function onDrawerPointerUp(e: PointerEvent) {
  const s = drawerSwipe
  if (!s || e.pointerId !== s.pointerId) return
  const dx = drawerDragX.value
  const shouldClose = s.tracking && (dx < -56 || dx < -s.width * 0.28)
  drawerSwipe = null
  drawerDragging.value = false
  if (shouldClose) {
    drawerDragX.value = 0
    setShowExplorer(false)
    return
  }
  drawerDragX.value = 0
}

function onDrawerPointerCancel(e: PointerEvent) {
  if (!drawerSwipe || e.pointerId !== drawerSwipe.pointerId) return
  drawerSwipe = null
  drawerDragging.value = false
  drawerDragX.value = 0
}

function setPanelExplorer(v: number) {
  layout.panelSizes = { ...layout.panelSizes, explorer: v }
  schedulePersist()
}

function setTheme(t: UiTheme) {
  uiTheme.value = t
  applyUiTheme(t)
  schedulePersist()
}

function setActiveGroup(g: string) {
  activeGroup.value = g
  schedulePersist()
}

function displayActiveGroup() {
  const ids = channelsInGroup.value.map((c) => c.id)
  onAssignGroup(ids)
}

function onTreeMenu(
  action: string,
  payload: { group?: string; channelId?: string; channelIds?: string[] } = {},
) {
  if (action === 'refresh') {
    void bootstrap()
    return
  }
  if (action === 'displayGroup' && payload.group) {
    activeGroup.value = payload.group
    const ids = channels.value
      .filter((c) => channelGroup(c) === payload.group && c.enabled)
      .map((c) => c.id)
    replaceWallWithGroup(ids)
    return
  }
  if (action === 'displayChannels' && payload.channelIds?.length) {
    replaceWallWithGroup(payload.channelIds)
    return
  }
  if (action === 'copyUrl' && payload.channelId) {
    const ch = channels.value.find((c) => c.id === payload.channelId)
    if (ch?.url) {
      void navigator.clipboard.writeText(ch.url).then(
        () => {
          status.value = '已复制主码流 URL'
        },
        () => {
          status.value = '复制失败'
        },
      )
    }
    return
  }
  hostOnly()
}

function onGlobalKey(e: KeyboardEvent) {
  if (!authed.value) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
    return
  }
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    setShowExplorer(mobile.value ? !mobileDrawer.value : !layout.showExplorer)
    return
  }
  if (mod && e.key.toLowerCase() === 't') {
    e.preventDefault()
    setShowTimeline(!layout.showTimeline)
    return
  }
  if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    setViewMode(viewMode.value === 'playback' ? 'live' : 'playback')
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
    void bootstrap()
    status.value = '已刷新'
  }
}

function updateMobile() {
  mobile.value = window.matchMedia('(max-width: 768px)').matches
  if (mobile.value) {
    mobileDrawer.value = false
    drawerDragX.value = 0
    drawerDragging.value = false
    drawerSwipe = null
  }
}

function startPolling() {
  stopPolling()
  let tick = 0
  pollTimer = setInterval(() => {
    // Playback: keep timeline fresh, but do NOT re-POST mosaic preview IDs —
    // that undoes enterPlayback()'s syncPreviews([]) and keeps host FFmpeg busy.
    if (viewMode.value === 'playback') {
      void refreshRecordings({ silent: true })
      return
    }
    tick += 1
    // Heartbeat demand ~every 10s; otherwise only GET states (no preview churn).
    if (tick % 4 === 1) void refreshPreviews()
    else void refreshStatesOnly()
  }, 2500)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
}

watch([slotIds, () => layout.mosaic, authed], () => {
  if (authed.value) scheduleSync()
})

watch(authed, (v) => {
  if (v) startPolling()
  else stopPolling()
})

async function loadPublicMeta() {
  try {
    const st = await fetchRemoteStatus()
    // Host upgraded but browser still runs a cached remote SPA → media URLs break
    // ("连接中" with zero requests). Force a cache-busting reload once per version.
    if (st.version && NM_UI_VERSION && st.version !== NM_UI_VERSION) {
      const key = `nm_ui_reload_${st.version}`
      try {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1')
          const u = new URL(location.href)
          u.searchParams.set('_v', st.version)
          location.replace(u.href)
          return
        }
      } catch {
        /* ignore storage / navigation failures */
      }
    }
    if (st.username) username.value = st.username
    if (st.version) {
      appMeta.value = {
        name: st.name ?? APP_NAME,
        version: st.version,
        license: st.license ?? APP_LICENSE,
        copyright: st.copyright ?? APP_COPYRIGHT,
        homepage: st.homepage ?? APP_HOMEPAGE,
        licenseNote: st.licenseNote ?? APP_LICENSE_NOTE,
      }
    }
  } catch {
    /* offline / not listening */
  }
}

onMounted(() => {
  document.documentElement.classList.add('remote-app')
  restoreLocalLayout()
  updateMobile()
  mq = window.matchMedia('(max-width: 768px)')
  mq.addEventListener('change', updateMobile)
  window.addEventListener('keydown', onGlobalKey)
  void loadPublicMeta()
  if (authed.value) void bootstrap()
})

onUnmounted(() => {
  document.documentElement.classList.remove('remote-app')
  mq?.removeEventListener('change', updateMobile)
  window.removeEventListener('keydown', onGlobalKey)
  stopPolling()
  if (layoutTimer) clearTimeout(layoutTimer)
})
</script>

<template>
  <div v-if="!authed" class="login">
    <form class="card" @submit.prevent="doLogin">
      <div class="brand">
        <img src="/icon.png" width="40" height="40" alt="" />
        <div>
          <h1>Navora Monitor</h1>
          <p>远程预览</p>
        </div>
      </div>
      <label>
        <span>账户</span>
        <input
          v-model="username"
          spellcheck="false"
          autocomplete="username"
          placeholder="admin"
        />
      </label>
      <label>
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="输入远程访问密码"
          autofocus
        />
      </label>
      <p v-if="loginError" class="err">{{ loginError }}</p>
      <button type="submit" class="primary" :disabled="loggingIn || !password.trim() || !username.trim()">
        {{ loggingIn ? '登录中…' : '登录' }}
      </button>
      <p class="login-meta">
        <span v-if="appMeta.version">v{{ appMeta.version }}</span>
        <span v-if="appMeta.version"> · </span>
        <span>{{ appMeta.license }} License</span>
      </p>
    </form>
  </div>

  <div v-else class="shell" :class="{ mobile }">
    <TitleBar
      :title="selected?.name ?? (viewMode === 'playback' ? '远程回放' : '远程预览')"
      :mosaic="layout.mosaic"
      :recording-count="recordingCount"
      :ffmpeg-ok="true"
      :groups="groups"
      :active-group="activeGroup"
      :show-explorer="mobile ? mobileDrawer : layout.showExplorer"
      :show-timeline="layout.showTimeline || viewMode === 'playback'"
      :view-mode="viewMode"
      :ui-theme="uiTheme"
      remote-mode
      :compact="mobile"
      @mosaic="setMosaic"
      @update:active-group="setActiveGroup"
      @update:show-explorer="setShowExplorer"
      @update:show-timeline="setShowTimeline"
      @update:view-mode="setViewMode"
      @update:ui-theme="setTheme"
      @logout="doLogout"
      @display-group="displayActiveGroup"
      @open-about="showAbout = true"
    />

    <div class="body">
      <template v-if="!mobile && layout.showExplorer">
        <DeviceTree
          class="explorer"
          :style="{ width: `${layout.panelSizes.explorer}px` }"
          :channels="channels"
          :states="states"
          :selected-id="selectedId"
          :active-group="activeGroup"
          :group-order="groupOrder"
          remote-mode
          @select="onSelect"
          @update:active-group="setActiveGroup"
          @menu="onTreeMenu"
          @add="() => hostOnly()"
          @manage-groups="() => hostOnly()"
          @scan-devices="() => hostOnly()"
          @batch-enable="() => hostOnly()"
          @batch-remove="() => hostOnly()"
          @batch-start="() => hostOnly()"
          @batch-stop="() => hostOnly()"
          @rename="() => hostOnly()"
          @move-to-group="() => hostOnly()"
          @move-channels-before="() => hostOnly()"
          @move-group-before="() => hostOnly()"
        />
        <ResizeHandle
          axis="horizontal"
          edge="end"
          :value="layout.panelSizes.explorer"
          :min="PANEL_LIMITS.explorer.min"
          :max="PANEL_LIMITS.explorer.max"
          @update:value="setPanelExplorer"
        />
      </template>

      <div class="center">
        <p v-if="loading" class="banner">加载中…</p>
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
          :auth-token="mediaAuthToken"
          :media-base-url="mediaBaseUrl"
          @exit="exitPlayback"
          @follow="onPlaybackFollow"
          @segment="onPlaybackSegment"
          @playlist-ended="onPlaylistEnded"
          @busy="(on) => (playbackBusy = on)"
          @update:rate="(r) => (playbackRate = r)"
        />
        <!-- Dedicated remote live grid: always mounts <video> when slots have channels. -->
        <RemoteLiveGrid
          v-else
          :mosaic="layout.mosaic"
          :channels="channels"
          :slot-ids="slotIds"
          :selected-id="selectedId"
          :mobile="mobile"
          :layout-mode="layoutMode"
          @select="onSelect"
        />
        <template v-if="showTimelinePanel">
          <ResizeHandle
            v-if="!mobile"
            axis="vertical"
            edge="start"
            :value="layout.panelSizes.timeline"
            :min="PANEL_LIMITS.timeline.min"
            :max="PANEL_LIMITS.timeline.max"
            @update:value="setPanelTimeline"
          />
          <TimelinePanel
            ref="timelineRef"
            :height="mobile ? mobileTimelineHeight : layout.panelSizes.timeline"
            :channel-id="selectedId"
            :channel-name="selected?.name ?? null"
            :segments="segments"
            :saved-clips="savedClips"
            :loading="segmentsLoading"
            :scrub-locked="viewMode === 'playback' && playbackBusy"
            :playing-id="playbackSeg?.id ?? null"
            :active="viewMode === 'playback'"
            :follow-ms="viewMode === 'playback' ? playbackFollowMs : null"
            :follow-live-edge="timelineFollowLiveEdge"
            :channel-recording="!!selectedId && states[selectedId]?.recording === 'recording'"
            remote-mode
            :mobile="mobile"
            @refresh="refreshRecordings"
            @activate="enterPlayback"
            @play="onPlaybackPlay"
            @scrub="onTimelineScrub"
            @update:rate="(r) => (playbackRate = r)"
            @update:source="(s) => (timelineSource = s)"
            @update:continuous="(v) => (playbackContinuous = v)"
            @save-clip="() => hostOnly('保存片段请在主机进行')"
            @delete-saved="() => hostOnly()"
            @export-range="() => hostOnly('导出请在主机进行')"
            @menu="() => hostOnly()"
          />
        </template>
      </div>
    </div>

    <div v-if="mobile && mobileDrawer" class="drawer-layer" aria-modal="true">
      <div class="scrim" @click="setShowExplorer(false)" />
      <div
        class="drawer-panel"
        :class="{ dragging: drawerDragging }"
        :style="{
          transform: drawerDragX ? `translate3d(${drawerDragX}px,0,0)` : undefined,
        }"
        @pointerdown="onDrawerPointerDown"
        @pointermove="onDrawerPointerMove"
        @pointerup="onDrawerPointerUp"
        @pointercancel="onDrawerPointerCancel"
      >
        <DeviceTree
          class="explorer drawer"
          remote-mode
          compact
          :channels="channels"
          :states="states"
          :selected-id="selectedId"
          :active-group="activeGroup"
          :group-order="groupOrder"
          @select="onSelect"
          @update:active-group="setActiveGroup"
          @menu="onTreeMenu"
          @add="() => hostOnly()"
          @manage-groups="() => hostOnly()"
          @scan-devices="() => hostOnly()"
          @batch-enable="() => hostOnly()"
          @batch-remove="() => hostOnly()"
          @batch-start="() => hostOnly()"
          @batch-stop="() => hostOnly()"
          @rename="() => hostOnly()"
          @move-to-group="() => hostOnly()"
          @move-channels-before="() => hostOnly()"
          @move-group-before="() => hostOnly()"
        />
      </div>
    </div>

    <StatusBar
      :message="status"
      :channel-count="channels.length"
      :recording-count="recordingCount"
      :app-version="appMeta.version || undefined"
      data-root="远程会话 · 布局保存在本机浏览器"
      :compact="mobile"
    />
    <ContextMenuHost />

    <div v-if="showAbout" class="about-mask" @click.self="showAbout = false">
      <div class="about-card" role="dialog" aria-label="关于">
        <div class="about-head">
          <img src="/icon.png" width="36" height="36" alt="" />
          <div>
            <h2>{{ appMeta.name }}</h2>
            <p>版本 {{ appMeta.version || '—' }}</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>开源协议</dt>
            <dd>{{ appMeta.license }} License</dd>
          </div>
          <div>
            <dt>版权</dt>
            <dd>{{ appMeta.copyright }}</dd>
          </div>
        </dl>
        <p class="about-note">{{ appMeta.licenseNote }}</p>
        <h3 class="about-sub">开源鸣谢</h3>
        <ul class="credits">
          <li v-for="item in OPEN_SOURCE_CREDITS" :key="item.url">
            <a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.name }}</a>
            <span v-if="item.note" class="credit-note">{{ item.note }}</span>
          </li>
        </ul>
        <div class="about-actions">
          <a
            v-if="appMeta.homepage"
            class="link"
            :href="appMeta.homepage"
            target="_blank"
            rel="noopener noreferrer"
          >
            项目主页
          </a>
          <button type="button" class="primary" @click="showAbout = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right))
    max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
  background:
    radial-gradient(ellipse 80% 50% at 50% -10%, rgb(13 107 84 / 18%), transparent),
    var(--bg);
}
.card {
  width: min(380px, 100%);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px 24px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}
.brand h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.brand p {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.card label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
}
.card input {
  height: 44px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  color: var(--text);
  font-size: 16px;
}
.card .primary {
  height: 44px;
  margin-top: 4px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  font-size: 15px;
}
.card .primary:disabled {
  opacity: 0.55;
  cursor: default;
}
.login-meta {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--muted);
}
.err {
  margin: 0;
  color: var(--danger);
  font-size: 12px;
}

.shell {
  height: 100dvh;
  height: 100svh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  padding-left: env(safe-area-inset-left, 0);
  padding-right: env(safe-area-inset-right, 0);
  position: relative;
}
.body {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  position: relative;
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
.banner {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
}
.shell.mobile :deep(.titlebar) {
  position: relative;
  z-index: 120;
  flex-shrink: 0;
}
.drawer-layer {
  position: absolute;
  top: calc(48px + env(safe-area-inset-top, 0px));
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 100;
  pointer-events: none;
}
.drawer-layer .scrim,
.drawer-layer .drawer-panel {
  pointer-events: auto;
}
.scrim {
  position: absolute;
  inset: 0;
  background: var(--mask);
  z-index: 1;
  animation: fade-in 0.18s ease;
}
.drawer-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(88vw, 320px);
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  box-shadow: var(--shadow);
  animation: drawer-in 0.22s ease;
  will-change: transform;
  touch-action: pan-y;
}
.drawer-panel.dragging {
  animation: none;
  transition: none;
}
.drawer-panel .explorer.drawer {
  flex: 1 1 0;
  width: 100% !important;
  min-height: 0;
  height: 100%;
}

@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes drawer-in {
  from {
    transform: translate3d(-12px, 0, 0);
    opacity: 0.85;
  }
  to {
    transform: translate3d(0, 0, 0);
    opacity: 1;
  }
}

.shell.mobile .center {
  background: #0c1118;
  /* Give timeline room above the home indicator on iOS Safari */
  padding-bottom: 0;
}

.shell.mobile .center :deep(.timeline.mobile) {
  border-top-color: color-mix(in srgb, var(--border) 80%, #000);
  box-shadow: 0 -8px 24px rgb(0 0 0 / 28%);
}

@media (max-width: 768px) {
  .card {
    padding: 24px 20px;
    border-radius: 16px;
  }
  .about-mask {
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
    align-items: end;
  }
  .about-card {
    width: 100%;
    border-radius: 16px 16px 12px 12px;
  }
}

.about-mask {
  position: fixed;
  inset: 0;
  z-index: 9000;
  background: var(--mask);
  display: grid;
  place-items: center;
  padding: 24px;
}
.about-card {
  width: min(420px, 100%);
  padding: 22px 20px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}
.about-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.about-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
.about-head p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.about-card dl {
  margin: 0 0 10px;
  display: grid;
  gap: 8px;
}
.about-card dl > div {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 8px;
  font-size: 12px;
}
.about-card dt {
  margin: 0;
  color: var(--muted);
}
.about-card dd {
  margin: 0;
}
.about-note {
  margin: 0 0 14px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.45;
}
.about-sub {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
}
.credits {
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
  max-height: min(220px, 36vh);
  overflow: auto;
}
.credits li {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}
.credits a {
  color: var(--accent);
  text-decoration: none;
}
.credits a:hover {
  text-decoration: underline;
}
.credit-note {
  color: var(--muted);
}
.about-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.about-actions .link {
  margin-right: auto;
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}
.about-actions .link:hover {
  text-decoration: underline;
}
.about-actions .primary {
  height: 32px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
</style>
