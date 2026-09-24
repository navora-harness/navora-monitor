<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { RecordingSegment } from '@shared/types'
import type { CtxMenuItem } from '@shared/context-menu'
import {
  formatSegmentClock,
  formatSegmentDayKey,
  formatSegmentDuration,
  formatSegmentTimeRange,
} from '@shared/segment-time'
import { isSparseTimeline, recentActivityRange } from '@shared/segment-range'
import { isSegmentWriting } from '@shared/segment-writing'
import { openContextMenu } from '../composables/useContextMenu'

const props = defineProps<{
  height: number
  channelId: string | null
  channelName: string | null
  segments: RecordingSegment[]
  savedClips: RecordingSegment[]
  loading?: boolean
  /** Block pan/scrub while media is loading or seeking */
  scrubLocked?: boolean
  savedClipMinutes?: number
  playingId?: string | null
  active?: boolean
  exportBusy?: boolean
  /** Wall-clock time from player — timeline follows when not grabbing */
  followMs?: number | null
  /**
   * Live preview + channel recording: keep playhead on "now"
   * (shows realtime / writing edge). Ignored while `active` (playback).
   */
  followLiveEdge?: boolean
  /** Remote browser — hide host-only save/export actions */
  remoteMode?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  play: [segment: RecordingSegment]
  scrub: [payload: { atMs: number; segment: RecordingSegment | null; seekSec: number }]
  saveClip: []
  deleteSaved: [segment: RecordingSegment]
  activate: []
  menu: [action: string, payload?: { channelId?: string; segmentId?: string }]
  'update:source': [source: 'loop' | 'saved']
  'update:rate': [rate: number]
  'update:continuous': [on: boolean]
  exportRange: [payload: { channelId: string; startMs: number; endMs: number; pickPath?: boolean }]
}>()

const MIN_PX_PER_MS = 8 / (24 * 60 * 60 * 1000) // ~8px / day
const MAX_PX_PER_MS = 120 / 1000 // 120px / second
const DEFAULT_PX_PER_MS = 48 / 60_000 // 48px / minute

const dayFilter = ref('')
const autoNext = ref(true)
const playbackRate = ref(1)
const source = ref<'loop' | 'saved'>('loop')
const hoverId = ref<string | null>(null)
/** Soft clock so “writing” gray blocks refresh as mtime ages out. */
const nowMs = ref(Date.now())
let writingClockTimer: ReturnType<typeof setInterval> | null = null
let liveEdgeTimer: ReturnType<typeof setInterval> | null = null

const viewportRef = ref<HTMLElement | null>(null)
const trackShiftRef = ref<HTMLElement | null>(null)
const rulerLayerRef = ref<HTMLElement | null>(null)
const gridLayerRef = ref<HTMLElement | null>(null)
const badgeRef = ref<HTMLElement | null>(null)
const viewportW = ref(640)
/** Wall-clock time under the fixed center playhead (committed; drives ticks). */
const centerMs = ref(Date.now())
const pxPerMs = ref(DEFAULT_PX_PER_MS)
const panning = ref(false)
const cursorMs = ref<number | null>(null)
const selectMode = ref(false)
const selA = ref<number | null>(null)
const selB = ref<number | null>(null)
const selecting = ref(false)
/** User is grabbing the strip — don't follow player */
const userGrabbing = ref(false)

let resizeObs: ResizeObserver | null = null
let panLastX = 0
let panPointerId: number | null = null
/** Structural viewport fit key — channel/source/day only (not drifting range ends). */
let viewFittedKey = ''
let selectAnchorMs = 0
let scrubTimer: ReturnType<typeof setTimeout> | null = null
let followLockUntil = 0
let panDistance = 0
let suppressClick = false
let resizeObsBound = false

/**
 * Live playhead time — updated imperatively during drag/wheel/follow
 * without touching Vue state (avoids tick/block class recomputation).
 */
let liveCenterMs = Date.now()
let transformRaf = 0
let wheelCommitTimer: ReturnType<typeof setTimeout> | null = null
let followCommitTimer: ReturnType<typeof setTimeout> | null = null
/** Non-reactive drag flag — avoids Vue re-render of every block on pointerdown. */
let panActive = false


/** After user pans/zooms, do not auto-fit until they click 适应. */
let userAnchored = false
/** Prefer this day when channel (OSD) switches — keep wall-clock window stable. */
let preferredDayOnChannelSwitch: string | null = null

function structuralFitKey(hasData: boolean): string {
  return `${props.channelId ?? ''}|${source.value}|${dayFilter.value}|${hasData ? '1' : '0'}`
}

const activeList = computed(() => (source.value === 'saved' ? props.savedClips : props.segments))

function segStart(s: RecordingSegment) {
  return s.startMs ?? s.mtimeMs
}

function segEnd(s: RecordingSegment) {
  return s.endMs ?? s.mtimeMs
}

const dayOptions = computed(() => {
  const set = new Set<string>()
  for (const s of activeList.value) set.add(formatSegmentDayKey(segStart(s)))
  return [...set].sort((a, b) => b.localeCompare(a))
})

watch(
  dayOptions,
  (days) => {
    if (preferredDayOnChannelSwitch) {
      const want = preferredDayOnChannelSwitch
      preferredDayOnChannelSwitch = null
      if (days.includes(want)) {
        dayFilter.value = want
        return
      }
      // Preferred day absent on this channel — fall through
    }
    if (!dayFilter.value && days[0]) dayFilter.value = days[0]!
    else if (dayFilter.value && days.length && !days.includes(dayFilter.value)) {
      dayFilter.value = days[0]!
    }
  },
  { immediate: true },
)

/** Chronological (oldest → newest) for timeline + continuous play */
const filteredAsc = computed(() => {
  let list = activeList.value
  if (dayFilter.value) {
    list = list.filter((s) => formatSegmentDayKey(segStart(s)) === dayFilter.value)
  }
  return [...list].sort((a, b) => segStart(a) - segStart(b))
})

const dataRange = computed(() => {
  const list = filteredAsc.value
  if (!list.length) return null
  let start = segStart(list[0]!)
  let end = segEnd(list[0]!)
  for (const s of list) {
    start = Math.min(start, segStart(s))
    end = Math.max(end, segEnd(s))
  }
  if (end <= start) end = start + 60_000
  return { start, end, span: end - start }
})

const title = computed(() => (props.channelName ? props.channelName : '全部通道'))

const saveHint = computed(() => {
  const m = props.savedClipMinutes ?? 10
  return `在时间轴框选并合并保存；默认选中最近约 ${m} 分钟`
})

const viewSpanMs = computed(() => Math.max(1000, viewportW.value / Math.max(pxPerMs.value, 1e-12)))
const viewStartMs = computed(() => centerMs.value - viewSpanMs.value / 2)
const viewEndMs = computed(() => centerMs.value + viewSpanMs.value / 2)

const centerLabel = computed(() => formatSegmentClock(centerMs.value, true))

const zoomLabel = computed(() => {
  const ppm = pxPerMs.value
  const pxPerMin = ppm * 60_000
  if (pxPerMin >= 80) return `${Math.round(ppm * 1000)}px/s`
  if (pxPerMin >= 8) return `${Math.round(pxPerMin)}px/分`
  const pxPerHour = ppm * 3_600_000
  if (pxPerHour >= 8) return `${Math.round(pxPerHour)}px/时`
  return `${Math.round(ppm * 86_400_000)}px/天`
})

type Tick = { ms: number; label: string; major: boolean; x: number }

const TICK_STEPS_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
]

function pickTickStep(spanMs: number, widthPx: number): number {
  const target = (spanMs / Math.max(widthPx, 1)) * 72
  for (const step of TICK_STEPS_MS) {
    if (step >= target) return step
  }
  return TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!
}

function formatTickLabel(ms: number, stepMs: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  if (stepMs >= 24 * 60 * 60_000) {
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  if (stepMs >= 60 * 60_000) return `${p(d.getHours())}:00`
  if (stepMs >= 60_000) return `${p(d.getHours())}:${p(d.getMinutes())}`
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

type BlockView = {
  seg: RecordingSegment
  left: number
  width: number
  writing: boolean
  startLabel: string
  endLabel: string
  showStart: boolean
  showEnd: boolean
  showDuration: boolean
  durationLabel: string
  rangeTitle: string
}

/**
 * Block geometry relative to dataRange.start — independent of pan center.
 * Parent track-shift translate moves them; avoids rebuilding on every drag frame.
 */
const originMs = computed(() => dataRange.value?.start ?? 0)

/** Absolute ticks (same coordinate system as blocks) — pan via shared transform. */
const ticks = computed(() => {
  const range = dataRange.value
  const w = viewportW.value
  if (!range || w <= 0) return [] as Tick[]
  const ppm = pxPerMs.value
  const origin = originMs.value
  const viewSpan = Math.max(1000, w / Math.max(ppm, 1e-12))
  const step = pickTickStep(viewSpan, w)
  const pad = viewSpan
  const start = range.start - pad
  const end = range.end + pad
  const first = Math.floor(start / step) * step
  const out: Tick[] = []
  const majorEvery = step >= 60_000 ? 1 : step >= 10_000 ? 6 : 5
  let i = 0
  for (let t = first; t <= end + step; t += step, i++) {
    out.push({
      ms: t,
      label: formatTickLabel(t, step),
      major: i % majorEvery === 0,
      x: (t - origin) * ppm,
    })
    if (out.length > 240) break
  }
  return out
})

const layoutBlocks = computed(() => {
  const origin = originMs.value
  const ppm = pxPerMs.value
  const withSec = ppm * 1000 >= 0.04
  const now = nowMs.value
  const out: BlockView[] = []
  for (const seg of filteredAsc.value) {
    const a = segStart(seg)
    const b = Math.max(a + 500, segEnd(seg))
    const left = (a - origin) * ppm
    const width = Math.max(3, (b - a) * ppm)
    const writing = isSegmentWriting(seg, now)
    out.push({
      seg,
      left,
      width,
      writing,
      startLabel: formatSegmentClock(a, withSec),
      endLabel: formatSegmentClock(b, withSec),
      showStart: width >= 44,
      showEnd: width >= 110,
      showDuration: width >= 160,
      durationLabel: formatSegmentDuration(a, b),
      rangeTitle: writing
        ? `${formatSegmentTimeRange(seg.startMs, seg.endMs)} · 正在录制中`
        : `${formatSegmentTimeRange(seg.startMs, seg.endMs)} · ${formatSegmentDuration(a, b)}`,
    })
  }
  return out
})

/** Translate so originMs sits such that `center` is at viewport midline. */
function trackOffsetFor(center: number): number {
  return viewportW.value / 2 - (center - originMs.value) * pxPerMs.value
}

/**
 * Paint strip position via DOM only — no Vue reactive updates.
 * Ruler, grid, and blocks share the same origin-based transform.
 */
function paintLiveCenter(center: number) {
  liveCenterMs = center
  const tx = trackOffsetFor(center)
  const t = `translate3d(${tx}px,0,0)`
  const track = trackShiftRef.value
  if (track) track.style.transform = t
  const ruler = rulerLayerRef.value
  if (ruler) ruler.style.transform = t
  const grid = gridLayerRef.value
  if (grid) grid.style.transform = t
  const badge = badgeRef.value
  if (badge) badge.textContent = formatSegmentClock(center, true)
}

function schedulePaint(center: number) {
  liveCenterMs = center
  if (transformRaf) return
  transformRaf = requestAnimationFrame(() => {
    transformRaf = 0
    paintLiveCenter(liveCenterMs)
  })
}

/** Commit live center into Vue (regenerates ticks once) and sync DOM. */
function commitCenter(center: number, scrub: 'none' | 'debounce' | 'immediate' = 'none') {
  liveCenterMs = center
  centerMs.value = center
  paintLiveCenter(center)
  if (scrub === 'immediate') scheduleScrub(true)
  else if (scrub === 'debounce') scheduleScrub(false)
}

const selectionInnerStyle = computed(() => {
  const sel = selection.value
  if (!sel) return null
  const left = (sel.startMs - originMs.value) * pxPerMs.value
  const width = Math.max(2, sel.spanMs * pxPerMs.value)
  return { left: `${left}px`, width: `${width}px` }
})

const hoverSeg = computed(() => {
  if (!hoverId.value) return null
  return filteredAsc.value.find((s) => s.id === hoverId.value) ?? null
})

const playingSeg = computed(() => {
  if (!props.playingId) return null
  return filteredAsc.value.find((s) => s.id === props.playingId) ?? null
})

const legendText = computed(() => {
  const seg = hoverSeg.value ?? playingSeg.value
  if (!seg) return null
  const a = segStart(seg)
  const b = Math.max(a, segEnd(seg))
  return {
    range: formatSegmentTimeRange(seg.startMs, seg.endMs),
    duration: formatSegmentDuration(a, b),
    locked: !!seg.protected,
  }
})

const cursorLabel = computed(() => {
  if (cursorMs.value == null) return ''
  return formatSegmentClock(cursorMs.value, true)
})

const underCenterSeg = computed(() => segmentAt(centerMs.value))

const selection = computed(() => {
  if (selA.value == null || selB.value == null) return null
  const startMs = Math.min(selA.value, selB.value)
  const endMs = Math.max(selA.value, selB.value)
  if (endMs - startMs < 200) return null
  return { startMs, endMs, spanMs: endMs - startMs }
})

const selectionOverlapCount = computed(() => {
  const sel = selection.value
  if (!sel) return 0
  return filteredAsc.value.filter((s) => {
    const a = segStart(s)
    const b = Math.max(a, segEnd(s))
    return a <= sel.endMs && b >= sel.startMs
  }).length
})

const selectionLabel = computed(() => {
  const sel = selection.value
  if (!sel) return ''
  return `${formatSegmentClock(sel.startMs, true)} – ${formatSegmentClock(sel.endMs, true)} · ${formatSegmentDuration(sel.startMs, sel.endMs)}`
})

function segmentAt(ms: number): RecordingSegment | null {
  const list = filteredAsc.value
  // Binary search first segment that ends after ms, then scan a few
  let lo = 0
  let hi = list.length - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = list[mid]!
    const b = Math.max(segStart(s) + 1, segEnd(s))
    if (b < ms) lo = mid + 1
    else {
      idx = mid
      hi = mid - 1
    }
  }
  if (idx < 0) return null
  for (let i = idx; i < Math.min(list.length, idx + 8); i++) {
    const s = list[i]!
    const a = segStart(s)
    const b = Math.max(a + 1, segEnd(s))
    if (ms >= a && ms <= b) return s
    if (a > ms) break
  }
  return null
}

function emitScrub() {
  const at = liveCenterMs
  const seg = segmentAt(at)
  emit('activate')
  // Do NOT snap the playhead on scrub — keep user's chosen wall time.
  // Player/controller may snap media to nearest keyframe; followLock keeps UI stable.
  if (!seg) {
    emit('scrub', { atMs: at, segment: null, seekSec: 0 })
    return
  }
  const seekSec = Math.max(0, (at - segStart(seg)) / 1000)
  emit('scrub', { atMs: at, segment: seg, seekSec })
}

function nearestSegmentAt(ms: number): RecordingSegment | null {
  const list = filteredAsc.value
  if (!list.length) return null
  let best = list[0]!
  let bestDist = Infinity
  for (const s of list) {
    const a = segStart(s)
    const b = Math.max(a + 1, segEnd(s))
    // Distance to nearest point on the segment (not only start) — avoids yanking to wrong clip
    const d = ms < a ? a - ms : ms > b ? ms - b : 0
    if (d < bestDist) {
      best = s
      bestDist = d
    }
  }
  return best
}

function scheduleScrub(immediate = false) {
  if (scrubTimer) clearTimeout(scrubTimer)
  // Always debounce — rapid drag-release / wheel must not stack segment loads
  scrubTimer = setTimeout(() => {
    scrubTimer = null
    emitScrub()
  }, immediate ? 120 : 280)
}

function setCenterAndScrub(ms: number, immediate = true) {
  followLockUntil = Date.now() + 1200
  commitCenter(ms, immediate ? 'immediate' : 'debounce')
}

function setSelectMode(on: boolean) {
  selectMode.value = on
  if (!on) {
    selecting.value = false
    selA.value = null
    selB.value = null
  }
}

function clearSelection() {
  selA.value = null
  selB.value = null
  selecting.value = false
}

/** Zoom/center so [startMs, endMs] fills most of the viewport. */
function zoomToRange(startMs: number, endMs: number, padRatio = 0.15) {
  const a = Math.min(startMs, endMs)
  const b = Math.max(startMs, endMs)
  const span = Math.max(2000, b - a)
  const pad = span * padRatio
  const viewSpan = span + pad * 2
  const w = Math.max(120, viewportW.value)
  userAnchored = true
  pxPerMs.value = clampZoom(w / viewSpan)
  commitCenter((a + b) / 2, 'none')
}

/**
 * Enter box-select mode with the settings look-back window preselected
 * (default ~10 min ending at now), then user can adjust and confirm merge.
 */
function beginSaveSelection(): { ok: true } | { ok: false; error: string } {
  if (!props.channelId) return { ok: false, error: '请先选择通道' }
  if (props.remoteMode) return { ok: false, error: '远程端不能保存片段' }

  setSource('loop')
  measureViewport()

  const minutes = Math.max(0.5, props.savedClipMinutes ?? 10)
  const durationMs = Math.round(minutes * 60_000)
  const endMs = Date.now()
  const startMs = endMs - durationMs

  // Prefer day of the window end so recent footage isn't hidden by an old day filter.
  // Clear filter if the window crosses midnight so both days stay visible.
  const startDay = formatSegmentDayKey(startMs)
  const endDay = formatSegmentDayKey(endMs)
  if (startDay !== endDay) dayFilter.value = ''
  else if (dayOptions.value.includes(endDay)) dayFilter.value = endDay
  else if (dayOptions.value[0]) dayFilter.value = dayOptions.value[0]!

  selectMode.value = true
  selecting.value = false
  selA.value = startMs
  selB.value = endMs
  zoomToRange(startMs, endMs)

  if (!props.segments.length) {
    return { ok: false, error: '暂无循环录像，请先开始录像后再保存' }
  }
  return { ok: true }
}

function clientXToMs(clientX: number): number {
  const el = viewportRef.value
  if (!el) return liveCenterMs
  const rect = el.getBoundingClientRect()
  const viewStart = liveCenterMs - viewportW.value / (2 * Math.max(pxPerMs.value, 1e-12))
  return viewStart + (clientX - rect.left) / pxPerMs.value
}

function onBlockClick(seg: RecordingSegment, e?: MouseEvent) {
  if (props.scrubLocked) return
  if (selectMode.value) return
  if (suppressClick) {
    suppressClick = false
    return
  }
  const at = e ? clientXToMs(e.clientX) : segStart(seg)
  const a = segStart(seg)
  const b = Math.max(a + 1, segEnd(seg))
  setCenterAndScrub(Math.min(b, Math.max(a, at)))
}

function requestExport(pickPath = false) {
  const sel = selection.value
  if (!sel || !props.channelId || props.exportBusy) return
  emit('activate')
  emit('exportRange', {
    channelId: props.channelId,
    startMs: sel.startMs,
    endMs: sel.endMs,
    pickPath,
  })
}

function setSource(next: 'loop' | 'saved') {
  source.value = next
  emit('update:source', next)
}

function onPlay(seg: RecordingSegment) {
  if (props.scrubLocked) return
  setCenterAndScrub(segStart(seg))
}

function playNext(): RecordingSegment | null {
  if (!props.playingId || !autoNext.value) return null
  const list = filteredAsc.value
  const i = list.findIndex((s) => s.id === props.playingId)
  if (i < 0 || i >= list.length - 1) return null
  const next = list[i + 1]!
  setCenterAndScrub(segStart(next))
  return next
}

function onActivateClick() {
  if (props.active) return
  if (!activeList.value.length) return
  emit('activate')
}

function clampZoom(v: number) {
  return Math.min(MAX_PX_PER_MS, Math.max(MIN_PX_PER_MS, v))
}

function measureViewport() {
  const el = viewportRef.value
  if (!el) return
  viewportW.value = Math.max(120, el.clientWidth)
}

function fitView(mode: 'auto' | 'all' = 'auto') {
  userAnchored = false
  const range = dataRange.value
  const list = filteredAsc.value
  if (!range || !list.length) {
    pxPerMs.value = DEFAULT_PX_PER_MS
    // Live browse: stay put if we already have a center; only seed once
    if (!Number.isFinite(liveCenterMs) || liveCenterMs <= 0) {
      commitCenter(Date.now(), 'none')
    } else {
      paintLiveCenter(liveCenterMs)
    }
    viewFittedKey = structuralFitKey(false)
    return
  }

  const timed = list.map((s) => ({
    startMs: segStart(s),
    endMs: Math.max(segStart(s) + 500, segEnd(s)),
  }))

  let start = range.start
  let end = range.end

  /**
   * In live mode (!active), never zoom to the "latest cluster" — that pins the
   * playhead at the live edge and feels like the timeline is dragged to the end.
   * Recent-cluster fit is only for playback when the day is sparse.
   */
  if (mode === 'auto' && props.active && isSparseTimeline(timed, range.span)) {
    const recent = recentActivityRange(timed, 20 * 60_000)
    if (recent) {
      start = recent.startMs
      end = recent.endMs
    }
  }

  const w = Math.max(120, viewportW.value)
  let span = Math.max(5_000, end - start)
  const pad = Math.max(span * 0.08, 20_000)
  span += pad * 2
  pxPerMs.value = clampZoom(w / Math.max(span, 3 * 60_000))
  commitCenter((start + end) / 2, 'none')
  viewFittedKey = structuralFitKey(true)
}

function fitAllView() {
  fitView('all')
}

defineExpose({
  autoNext,
  playbackRate,
  source,
  filtered: filteredAsc,
  playNext,
  fitView: fitAllView,
  scrubTo: setCenterAndScrub,
  beginSaveSelection,
  clearSelection,
  setSelectMode,
  setSource,
})

watch(
  autoNext,
  (on) => emit('update:continuous', on),
  { immediate: true },
)

watch(
  source,
  (s) => emit('update:source', s),
  { immediate: true },
)

function centerOnPlaying() {
  if (props.followMs != null) {
    commitCenter(props.followMs, 'none')
    return
  }
  const seg = playingSeg.value
  if (!seg) return
  const a = segStart(seg)
  const b = Math.max(a + 1000, segEnd(seg))
  commitCenter((a + b) / 2, 'none')
}

function zoomAt(_clientX: number, factor: number) {
  // Keep center playhead time fixed while zooming
  pxPerMs.value = clampZoom(pxPerMs.value * factor)
  // Zoom rebuilds block geometry — re-paint strip at same center
  nextTick(() => paintLiveCenter(liveCenterMs))
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  userAnchored = true
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    panActive = true
    userGrabbing.value = true
    schedulePaint(liveCenterMs + (e.deltaY || e.deltaX) / pxPerMs.value)
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer)
    wheelCommitTimer = setTimeout(() => {
      wheelCommitTimer = null
      panActive = false
      userGrabbing.value = false
      followLockUntil = Date.now() + 2500
      commitCenter(liveCenterMs, 'debounce')
    }, 120)
    return
  }
  const zoomIn = e.deltaY < 0
  zoomAt(e.clientX, zoomIn ? 1.12 : 1 / 1.12)
}

function onViewportPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  if (props.scrubLocked) {
    e.preventDefault()
    return
  }
  const el = viewportRef.value
  if (!el) return

  if (selectMode.value) {
    selecting.value = true
    selectAnchorMs = clientXToMs(e.clientX)
    selA.value = selectAnchorMs
    selB.value = selectAnchorMs
    panPointerId = e.pointerId
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
    return
  }

  userGrabbing.value = true
  panActive = true
  panning.value = true
  userAnchored = true
  panDistance = 0
  suppressClick = false
  panLastX = e.clientX
  panPointerId = e.pointerId
  el.setPointerCapture(e.pointerId)
}

function onViewportPointerMove(e: PointerEvent) {
  if (panPointerId !== e.pointerId) return

  if (selecting.value && selectMode.value) {
    selB.value = clientXToMs(e.clientX)
    return
  }

  if (!panActive) return
  const dx = e.clientX - panLastX
  panLastX = e.clientX
  panDistance += Math.abs(dx)
  schedulePaint(liveCenterMs - dx / pxPerMs.value)
}

function onViewportPointerUp(e: PointerEvent) {
  if (panPointerId !== e.pointerId) return
  const wasPanning = panActive
  panActive = false
  panning.value = false
  selecting.value = false
  panPointerId = null
  userGrabbing.value = false
  followLockUntil = Date.now() + 2500
  if (panDistance > 5) suppressClick = true
  if (transformRaf) {
    cancelAnimationFrame(transformRaf)
    transformRaf = 0
  }
  try {
    viewportRef.value?.releasePointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  // Debounce media scrub — timeline stays at release position via followLock
  commitCenter(liveCenterMs, wasPanning && !selectMode.value ? 'debounce' : 'none')
}

function onViewportPointerLeave() {
  if (!panning.value) cursorMs.value = null
}

function onViewportDblClick(e: MouseEvent) {
  if (props.scrubLocked) return
  const t = e.target as HTMLElement | null
  if (t?.closest('.block')) return
  if (selectMode.value) return
  fitAllView()
}

function onPanelCtx(e: MouseEvent) {
  const items: CtxMenuItem[] = []
  if (!props.remoteMode) {
    items.push({ id: 'saveClip', label: '框选保存片段…', disabled: !props.channelId }, { separator: true })
  }
  items.push(
    { id: 'fit', label: '适应全部片段' },
    { id: 'fitRecent', label: '适应最近录像' },
    { id: 'centerPlaying', label: '定位到正在播放', disabled: !props.playingId },
  )
  if (!props.remoteMode) {
    items.push({ id: 'selectExport', label: selectMode.value ? '退出框选导出' : '框选导出…' })
  }
  items.push({ separator: true }, { id: 'refresh', label: '刷新时间轴' })
  if (!props.remoteMode) {
    items.push(
      { id: 'reveal', label: source.value === 'saved' ? '打开已保存目录' : '打开录像目录' },
      { separator: true },
      { id: 'repairConfig', label: '修复配置' },
    )
  }
  openContextMenu(e, items, (id) => {
    if (id === 'refresh') {
      emit('refresh')
      return
    }
    if (id === 'saveClip') {
      emit('saveClip')
      return
    }
    if (id === 'fit') {
      fitAllView()
      return
    }
    if (id === 'fitRecent') {
      fitView('auto')
      return
    }
    if (id === 'centerPlaying') {
      centerOnPlaying()
      return
    }
    if (id === 'selectExport') {
      setSelectMode(!selectMode.value)
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
  const items: CtxMenuItem[] = [{ id: 'play', label: '播放' }]
  if (!props.remoteMode) {
    items.push({ id: 'reveal', label: '打开所在目录' }, { separator: true })
    if (seg.protected) {
      items.push({ id: 'deleteSaved', label: '删除已保存（不可恢复）', danger: true })
    } else {
      items.push({ id: 'saveClip', label: '框选保存片段…' })
    }
  }
  items.push({ separator: true }, { id: 'refresh', label: '刷新时间轴' })

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

watch(
  () => props.scrubLocked,
  (locked) => {
    if (!locked) return
    // Abort in-flight drag so release doesn't fire another scrub
    if (panActive || selecting.value) {
      panActive = false
      panning.value = false
      selecting.value = false
      userGrabbing.value = false
      panPointerId = null
      if (scrubTimer) {
        clearTimeout(scrubTimer)
        scrubTimer = null
      }
    }
  },
)

watch(playbackRate, (r) => emit('update:rate', r))

watch(source, () => {
  dayFilter.value = ''
  viewFittedKey = ''
  userAnchored = false
})

watch(dayFilter, () => {
  viewFittedKey = ''
})

watch(
  () => props.channelId,
  (id, prev) => {
    if (id === prev) return
    // Switching OSD: keep the same wall-clock center + zoom. Auto-fit / jump-to-now
    // feels like the timeline "twitches" on every cell select.
    preferredDayOnChannelSwitch = formatSegmentDayKey(liveCenterMs)
    dayFilter.value = ''
    userAnchored = true
    followLockUntil = Date.now() + 1500
    void nextTick(() => {
      viewFittedKey = structuralFitKey(filteredAsc.value.length > 0)
      paintLiveCenter(liveCenterMs)
    })
  },
)

watch(
  () => props.followLiveEdge,
  (on) => {
    if (props.active || !on) {
      stopLiveEdgeFollow()
      return
    }
    // Do not commitCenter(now) here — that yanks the strip when selecting a
    // recording OSD. Live-edge ticks only nudge when already near "now".
    startLiveEdgeFollow()
  },
)

watch(
  () => props.active,
  (on, was) => {
    if (on) {
      stopLiveEdgeFollow()
      return
    }
    // Leaving playback → live
    if (was && !on) {
      if (props.followLiveEdge) {
        // Resume live edge only if we were already near now
        followLockUntil = 0
        if (Math.abs(Date.now() - liveCenterMs) <= 20_000) {
          userAnchored = false
          commitCenter(Date.now(), 'none')
        } else {
          userAnchored = true
        }
        startLiveEdgeFollow()
      } else {
        userAnchored = true
        followLockUntil = Date.now() + 3000
      }
    } else if (props.followLiveEdge) {
      startLiveEdgeFollow()
    }
  },
)

/**
 * Auto-fit only on structural changes (channel / source / day / empty↔data).
 * Do NOT refit when segment endMs drifts on poll — that causes constant flicker
 * and yanks the playhead to the live edge while watching realtime.
 */
watch(
  () => structuralFitKey(filteredAsc.value.length > 0),
  async (key) => {
    await nextTick()
    measureViewport()
    bindResizeObserver()
    if (key === viewFittedKey) return
    // User has panned/zoomed — keep their place; just accept the new key
    if (userAnchored) {
      viewFittedKey = key
      return
    }
    fitView('auto')
  },
  { immediate: true },
)

watch(
  () => props.playingId,
  () => {
    // Do not auto-recenter on segment change — that fights scrub and causes bounce.
    // Timeline position is owned by user pan + player followMs.
  },
)

watch(
  () => props.followMs,
  (ms) => {
    // Playback mode: follow player wall clock
    if (!props.active) return
    if (ms == null || userGrabbing.value || selectMode.value || panActive) return
    if (Date.now() < followLockUntil) return
    if (Math.abs(ms - liveCenterMs) < 80) return
    schedulePaint(ms)
    if (followCommitTimer) return
    followCommitTimer = setTimeout(() => {
      followCommitTimer = null
      if (!props.active || userGrabbing.value || panActive) return
      if (Date.now() < followLockUntil) return
      if (Math.abs(liveCenterMs - centerMs.value) > 250) {
        centerMs.value = liveCenterMs
      }
    }, 800)
  },
)

function tickLiveEdge() {
  if (props.active || !props.followLiveEdge) return
  if (userGrabbing.value || selectMode.value || panActive) return
  if (Date.now() < followLockUntil) return
  const now = Date.now()
  // Far from live edge = browsing history (or just switched OSD). Don't yank.
  if (Math.abs(now - liveCenterMs) > 20_000) return
  nowMs.value = now
  schedulePaint(now)
  if (Math.abs(now - centerMs.value) > 400) {
    centerMs.value = now
  }
}

function startLiveEdgeFollow() {
  if (liveEdgeTimer) return
  tickLiveEdge()
  liveEdgeTimer = setInterval(tickLiveEdge, 1000)
}

function stopLiveEdgeFollow() {
  if (liveEdgeTimer) {
    clearInterval(liveEdgeTimer)
    liveEdgeTimer = null
  }
}

/** Zoom / data origin / width change: re-paint transform but keep liveCenter (do not snap back). */
watch(
  [pxPerMs, originMs, viewportW],
  () => {
    if (panActive || userGrabbing.value) return
    paintLiveCenter(liveCenterMs)
  },
  { flush: 'post' },
)

watch(centerMs, (ms) => {
  if (panActive || userGrabbing.value) return
  // Only when center was explicitly committed (scrub release / fit), sync live
  if (Math.abs(ms - liveCenterMs) < 1) {
    paintLiveCenter(ms)
    return
  }
  // If follow already moved live ahead of committed center, keep live — don't bounce
  if (Math.abs(ms - liveCenterMs) > 40 && Date.now() < followLockUntil) {
    paintLiveCenter(liveCenterMs)
    return
  }
  liveCenterMs = ms
  paintLiveCenter(ms)
})

function bindResizeObserver() {
  const el = viewportRef.value
  if (!el || typeof ResizeObserver === 'undefined') return
  if (resizeObsBound && resizeObs) return
  resizeObs?.disconnect()
  resizeObs = new ResizeObserver(() => {
    measureViewport()
    if (!panning.value) paintLiveCenter(liveCenterMs)
  })
  resizeObs.observe(el)
  resizeObsBound = true
}

onMounted(() => {
  measureViewport()
  bindResizeObserver()
  paintLiveCenter(centerMs.value)
  writingClockTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 2000)
  if (props.followLiveEdge && !props.active) startLiveEdgeFollow()
})

onUnmounted(() => {
  resizeObs?.disconnect()
  resizeObs = null
  resizeObsBound = false
  if (scrubTimer) clearTimeout(scrubTimer)
  if (transformRaf) cancelAnimationFrame(transformRaf)
  if (wheelCommitTimer) clearTimeout(wheelCommitTimer)
  if (followCommitTimer) clearTimeout(followCommitTimer)
  if (writingClockTimer) clearInterval(writingClockTimer)
  writingClockTimer = null
  stopLiveEdgeFollow()
})
</script>

<template>
  <section
    class="timeline"
    :class="{ active, armed: !active && activeList.length > 0, compact: height <= 96 }"
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
          v-if="!remoteMode"
          type="button"
          class="save"
          :disabled="!channelId"
          :class="{ on: selectMode }"
          :title="saveHint"
          @click="emit('saveClip')"
        >
          保存片段
        </button>
        <select v-model="dayFilter" title="按日期筛选" class="day">
          <option v-if="!dayOptions.length" value="">无录像</option>
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
        <button
          v-if="!remoteMode"
          type="button"
          class="ghost"
          :class="{ on: selectMode }"
          title="框选时间段并导出合并片段"
          :disabled="!channelId || source !== 'loop'"
          @click="setSelectMode(!selectMode)"
        >
          框选导出
        </button>
        <button type="button" class="ghost" title="适应最近录像；双击轨道适应全部" @click="fitView('auto')">
          适应
        </button>
        <button
          type="button"
          class="ghost"
          title="定位到正在播放"
          :disabled="!playingId"
          @click="centerOnPlaying"
        >
          定位
        </button>
        <button type="button" class="ghost" @click="emit('refresh')">刷新</button>
      </div>
    </div>

    <div class="body" @click.stop>
      <p v-if="loading && !filteredAsc.length" class="hint">加载中…</p>
      <p v-else-if="!filteredAsc.length" class="hint">
        <template v-if="source === 'saved'">
          暂无已保存片段。点「保存片段」可在时间轴框选时段，裁切拼接后存入受保护目录。
        </template>
        <template v-else>
          {{ segments.length ? '该日期无录像时间轴。' : '暂无录像。开始录像后将按时间轨迹显示。' }}
        </template>
      </p>
      <template v-else>
        <div
          ref="viewportRef"
          class="viewport"
          :class="{ panning, selecting: selectMode, locked: scrubLocked }"
          :title="scrubLocked ? '加载中，请稍候…' : undefined"
          @wheel.prevent="onWheel"
          @pointerdown="onViewportPointerDown"
          @pointermove="onViewportPointerMove"
          @pointerup="onViewportPointerUp"
          @pointercancel="onViewportPointerUp"
          @pointerleave="onViewportPointerLeave"
          @dblclick="onViewportDblClick"
        >
          <div ref="rulerLayerRef" class="ruler-layer">
            <div class="ruler">
              <span
                v-for="t in ticks"
                :key="t.ms"
                class="tick"
                :class="{ major: t.major }"
                :style="{ left: `${t.x}px` }"
              >
                <i class="mark" />
                <span v-if="t.major" class="lab">{{ t.label }}</span>
              </span>
            </div>
          </div>
          <div class="track">
            <div ref="gridLayerRef" class="grid-layer">
              <div
                v-for="t in ticks"
                :key="`g-${t.ms}`"
                class="grid"
                :class="{ major: t.major }"
                :style="{ left: `${t.x}px` }"
              />
            </div>
            <div ref="trackShiftRef" class="track-shift">
              <div
                v-if="selectionInnerStyle"
                class="sel-range"
                :style="selectionInnerStyle"
                aria-hidden="true"
              />
              <button
                v-for="b in layoutBlocks"
                :key="b.seg.id"
                type="button"
                class="block"
                :class="{
                  active: playingId === b.seg.id || underCenterSeg?.id === b.seg.id,
                  locked: b.seg.protected,
                  writing: b.writing,
                  hover: hoverId === b.seg.id,
                }"
                :style="{ left: `${b.left}px`, width: `${b.width}px` }"
                :title="b.rangeTitle"
                @click.stop="onBlockClick(b.seg, $event)"
                @mouseenter="hoverId = b.seg.id"
                @mouseleave="hoverId = null"
                @contextmenu.stop="onSegCtx($event, b.seg)"
              >
                <span v-if="b.showStart" class="t-start">{{ b.startLabel }}</span>
                <span v-if="b.showDuration" class="t-dur">{{ b.durationLabel }}</span>
                <span v-if="b.showEnd" class="t-end">{{ b.endLabel }}</span>
              </button>
            </div>
          </div>
          <div class="playhead" aria-hidden="true">
            <div class="needle" />
            <div ref="badgeRef" class="badge">{{ centerLabel }}</div>
          </div>
        </div>
        <div v-if="!remoteMode && (selectMode || selection)" class="export-bar" @click.stop>
          <template v-if="selection">
            <span class="export-range">{{ selectionLabel }}</span>
            <span class="export-meta">覆盖 {{ selectionOverlapCount }} 段</span>
            <button
              type="button"
              class="primary"
              :disabled="!channelId || selectionOverlapCount < 1 || exportBusy"
              @click="requestExport(false)"
            >
              {{ exportBusy ? '裁切拼接中…' : '确认保存' }}
            </button>
            <button
              type="button"
              class="ghost"
              :disabled="!channelId || selectionOverlapCount < 1 || exportBusy"
              @click="requestExport(true)"
            >
              另存为…
            </button>
            <button type="button" class="ghost" @click="clearSelection">清除</button>
            <button type="button" class="ghost" @click="setSelectMode(false)">取消</button>
          </template>
          <template v-else>
            <span class="muted">框选模式：在轨道上拖动选择起止时间，确认后自动裁切并拼接为一段</span>
            <button type="button" class="ghost" @click="setSelectMode(false)">取消</button>
          </template>
        </div>
        <div class="legend">
          <span class="sel playhead-time">
            {{ centerLabel }}
            <span v-if="underCenterSeg" class="dim">
              · {{
                followLiveEdge && !active
                  ? '实时录制'
                  : isSegmentWriting(underCenterSeg, nowMs)
                    ? '正在录制中'
                    : underCenterSeg.protected
                      ? '已保存'
                      : '录像'
              }}
              · {{ formatSegmentDuration(segStart(underCenterSeg), Math.max(segStart(underCenterSeg), segEnd(underCenterSeg))) }}
            </span>
            <span v-else-if="followLiveEdge && !active" class="dim"> · 实时录制</span>
            <span v-else class="dim"> · 无录像</span>
          </span>
          <span class="muted">
            <template v-if="selectMode">拖动调整保存范围，确认后裁切拼接</template>
            <template v-else-if="followLiveEdge && !active">实时跟播 · 中线为当前时间 · 共 {{ filteredAsc.length }} 段</template>
            <template v-else>抓取滚动 · 中线为播放点 · 滚轮缩放 · 共 {{ filteredAsc.length }} 段</template>
          </span>
          <span class="right">
            <span class="zoom" :title="zoomLabel">{{ zoomLabel }}</span>
          </span>
        </div>
      </template>
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
  gap: 6px;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
  min-height: 28px;
  flex-shrink: 0;
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
  height: 22px;
  min-width: 56px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
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
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  font-weight: 500;
  color: var(--text);
  font-size: 11px;
}
.actions button.save {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
}
.actions button.save.on {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
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
  flex-direction: column;
  padding: 4px 10px 6px;
  gap: 4px;
  cursor: default;
}
.hint {
  margin: 4px 0;
  font-size: 12px;
  color: var(--muted);
}
.viewport {
  flex: 1;
  min-height: 40px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  user-select: none;
  touch-action: none;
  cursor: grab;
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}
.actions button.ghost.on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
}
.viewport.panning {
  cursor: grabbing;
}
.viewport.selecting {
  cursor: crosshair;
}
.viewport.locked {
  cursor: wait;
  opacity: 0.85;
}
.playhead {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 12;
}
.playhead .needle {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  background: var(--rec, #e11d48);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 25%);
}
.playhead .needle::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 8px solid var(--rec, #e11d48);
}
.playhead .badge {
  position: absolute;
  top: 2px;
  left: 50%;
  transform: translateX(-50%);
  padding: 1px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--rec, #e11d48) 92%, #000);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
}
.legend .playhead-time {
  font-variant-numeric: tabular-nums;
}
.sel-range {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 10%);
  pointer-events: none;
  z-index: 4;
}
.export-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 32px;
  padding: 4px 2px 0;
  font-size: 12px;
}
.export-range {
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.export-meta {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.export-bar .primary {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-weight: 650;
  cursor: pointer;
}
.export-bar .primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.export-bar .ghost {
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
}
.export-bar .muted {
  color: var(--muted);
  flex: 1;
  min-width: 0;
}
.ruler-layer {
  position: relative;
  height: 16px;
  margin: 0 1px;
  overflow: hidden;
  flex-shrink: 0;
  will-change: transform;
  contain: layout style;
}
.ruler {
  position: relative;
  height: 100%;
  overflow: visible;
}
.tick {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  pointer-events: none;
}
.tick .mark {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 1px;
  height: 6px;
  background: color-mix(in srgb, var(--border) 80%, var(--muted));
}
.tick.major .mark {
  height: 10px;
  background: var(--muted);
}
.tick .lab {
  position: absolute;
  left: 0;
  top: 0;
  transform: translateX(-50%);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  white-space: nowrap;
}
.track {
  position: relative;
  flex: 1;
  min-height: 24px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
}
.track-shift {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 0;
  will-change: transform;
  contain: layout style;
  z-index: 2;
}
.grid-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  will-change: transform;
  pointer-events: none;
  contain: layout style;
}
.grid {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--border) 45%, transparent);
  pointer-events: none;
}
.grid.major {
  background: color-mix(in srgb, var(--border) 85%, transparent);
}
.block {
  position: absolute;
  top: 4px;
  bottom: 4px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 72%, #0d6b54);
  cursor: pointer;
  min-width: 3px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 12%);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  overflow: hidden;
  color: #fff;
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  content-visibility: auto;
  contain-intrinsic-size: auto 28px;
}
.block:hover,
.block.hover {
  filter: brightness(1.12);
  z-index: 2;
}
.block.active {
  background: var(--rec);
  z-index: 3;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--rec) 40%, transparent);
}
.block.locked {
  background: color-mix(in srgb, var(--chart-saved) 80%, var(--accent));
}
.block.locked.active {
  background: var(--rec);
}
.block.writing {
  background: color-mix(in srgb, #9ca3af 55%, #4b5563);
  color: #f3f4f6;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 8%);
}
.block.writing:hover,
.block.writing.hover {
  filter: brightness(1.08);
}
.block.writing.active {
  background: color-mix(in srgb, #9ca3af 70%, #374151);
  box-shadow: 0 0 0 2px color-mix(in srgb, #9ca3af 45%, transparent);
}
.block.writing.locked {
  background: color-mix(in srgb, #9ca3af 50%, #6b7280);
}
.t-start,
.t-end,
.t-dur {
  flex-shrink: 0;
  text-shadow: 0 1px 1px rgb(0 0 0 / 35%);
  pointer-events: none;
}
.t-dur {
  flex: 1;
  min-width: 0;
  text-align: center;
  opacity: 0.92;
  font-weight: 600;
}
.legend {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 16px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.legend .sel {
  color: var(--text);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend .dim {
  font-weight: 500;
  color: var(--muted);
}
.legend .muted {
  color: var(--muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend .right {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  color: var(--muted);
}
.legend .cur {
  color: var(--text);
  font-weight: 600;
}
.legend .zoom {
  opacity: 0.85;
}

/* Ultra-compact: keep track usable when dragged to PANEL_LIMITS.timeline.min */
.timeline.compact .head {
  min-height: 24px;
  padding: 1px 6px;
}
.timeline.compact .actions button,
.timeline.compact .day,
.timeline.compact .rate {
  height: 22px;
  padding: 0 6px;
  font-size: 10px;
}
.timeline.compact .tabs button {
  height: 20px;
  min-width: 48px;
  font-size: 10px;
}
.timeline.compact .body {
  padding: 2px 8px 3px;
  gap: 2px;
}
.timeline.compact .ruler {
  height: 14px;
}
.timeline.compact .track {
  min-height: 22px;
  border-radius: 5px;
}
.timeline.compact .block {
  top: 3px;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 4px;
}
.timeline.compact .legend .muted {
  display: none;
}
.timeline.compact .playhead .badge {
  font-size: 9px;
  padding: 0 5px;
}
</style>
