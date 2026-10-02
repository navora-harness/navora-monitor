import type { NavoraMonitorApi } from '@shared/ipc-types'
import { sanitizeUiLayout } from '@shared/panel-sizes'
import { browserSupportsHevcMse } from '@shared/hevc-mse'
import { requestPick, requestReveal } from './dialogs'

const LAYOUT_KEY = 'navora-web-layout-v1'

let previewIds: string[] = []
let events: EventSource | null = null
let ws: WebSocket | null = null
let watchChannelId = ''
let lastTimelineAt = 0

const scanListeners = new Set<(v: any) => void>()
const storageActionListeners = new Set<(v: any) => void>()
const storageListeners = new Set<(v: any) => void>()
const visibilityListeners = new Set<(v: { visible: boolean }) => void>()
const teardownListeners = new Set<() => void>()
const timelineListeners = new Set<(v: any) => void>()
const stateListeners = new Set<(v: any) => void>()
let hooksInstalled = false

function dispatchPush(msg: { event?: string; data?: any }) {
  if (!msg?.event) return
  if (msg.event === 'scan') scanListeners.forEach((fn) => fn(msg.data))
  else if (msg.event === 'storageAction') storageActionListeners.forEach((fn) => fn(msg.data))
  else if (msg.event === 'storage') storageListeners.forEach((fn) => fn(msg.data))
  else if (msg.event === 'timeline') {
    lastTimelineAt = Date.now()
    timelineListeners.forEach((fn) => fn(msg.data))
  } else if (msg.event === 'states') stateListeners.forEach((fn) => fn(msg.data))
}

function sendWatch() {
  if (ws?.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ op: 'watch', channelId: watchChannelId }))
}

function ensureSse() {
  if (events || typeof window === 'undefined') return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  events = new EventSource('/api/events')
  events.addEventListener('scan', (ev) => {
    dispatchPush({ event: 'scan', data: JSON.parse((ev as MessageEvent).data) })
  })
  events.addEventListener('storageAction', (ev) => {
    dispatchPush({ event: 'storageAction', data: JSON.parse((ev as MessageEvent).data) })
  })
  events.addEventListener('storage', (ev) => {
    dispatchPush({ event: 'storage', data: JSON.parse((ev as MessageEvent).data) })
  })
}

function connectWs() {
  if (typeof window === 'undefined') return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const sock = new WebSocket(proto + location.host + '/api/ws')
  ws = sock
  sock.onmessage = (ev) => {
    try {
      dispatchPush(JSON.parse(String(ev.data)))
    } catch {
      /* ignore malformed push */
    }
  }
  sock.onopen = () => {
    sendWatch()
    if (events) {
      events.close()
      events = null
    }
  }
  sock.onclose = () => {
    if (ws === sock) ws = null
    ensureSse()
    window.setTimeout(connectWs, 1500)
  }
}

function installHooks() {
  if (hooksInstalled || typeof window === 'undefined') return
  hooksInstalled = true
  const emitVis = () => {
    const visible = document.visibilityState !== 'hidden'
    visibilityListeners.forEach((fn) => fn({ visible }))
  }
  document.addEventListener('visibilitychange', emitVis)
  window.addEventListener('pagehide', () => {
    teardownListeners.forEach((fn) => fn())
    previewIds = []
    void fetch('/api/previews', {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: '{"channelIds":[]}',
    }).catch(() => undefined)
  })
  window.setInterval(() => {
    if (document.visibilityState === 'hidden') return
    const live = (ws && ws.readyState === WebSocket.OPEN) || events
    if (!live) return
    void post('/api/previews', { channelIds: previewIds }).catch(() => undefined)
  }, 10_000)
}

export function startEvents() {
  installHooks()
  connectWs()
  ensureSse()
}

async function parse(res: Response): Promise<any> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: text }
  }
}

async function send(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  })
  const data = await parse(res)
  if (res.status === 401) {
    const err = new Error(data?.error || '未登录')
    ;(err as Error & { status?: number }).status = 401
    throw err
  }
  if (!res.ok && data && data.error && data.ok !== false) {
    throw new Error(data.error)
  }
  return data
}

function post(path: string, body?: unknown) {
  return send(path, { method: 'POST', body: body == null ? '{}' : JSON.stringify(body) })
}

export async function probeSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/session', { credentials: 'include' })
    return res.ok
  } catch {
    return false
  }
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await parse(res)
  if (!res.ok) throw new Error(data?.error || '登录失败')
}

export async function logout(): Promise<void> {
  previewIds = []
  try {
    await post('/api/logout')
  } catch {
    /* ignore */
  }
}

export async function uploadConfigFile(file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return send('/api/config/upload', { method: 'POST', body: fd })
}

function joinServer(root: string, id?: string): string {
  if (!id) return root
  const sep = root.includes('\\') ? '\\' : '/'
  return root.replace(/[\\/]+$/, '') + sep + id
}

function readLocalLayout(): unknown {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeLocalLayout(layout: unknown) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
}

export function createMonitorApi(): NavoraMonitorApi {
  installHooks()

  const api: NavoraMonitorApi = {
    async getAppInfo() {
      return send('/api/app-info')
    },
    async openExternal(url: string) {
      window.open(url, '_blank', 'noopener')
      return { ok: true }
    },
    async shutdownApp() {
      return post('/api/shutdown')
    },
    async getSettings() {
      return send('/api/settings')
    },
    async setSettings(patch) {
      const cur = await send('/api/settings')
      return send('/api/settings', { method: 'PUT', body: JSON.stringify({ ...cur, ...patch }) })
    },
    async getDiskSpace() {
      return send('/api/disk')
    },
    async runStorageCleanup() {
      return post('/api/storage/cleanup')
    },
    async clearAllLoopRecordings() {
      return post('/api/storage/clear-loop')
    },
    onStorageAction(cb) {
      storageActionListeners.add(cb)
      return () => storageActionListeners.delete(cb)
    },
    onStorageChanged(cb) {
      storageListeners.add(cb)
      return () => storageListeners.delete(cb)
    },
    async repairConfig() {
      return post('/api/repair/config', {})
    },
    async repairRecordingTimestamps(opts) {
      return post('/api/repair/timestamps', opts ?? {})
    },
    async exportConfig(opts) {
      const picked = await requestPick({
        mode: 'save',
        title: '导出配置',
        saveName: 'navora-monitor-config.json',
      })
      if ('canceled' in picked) return { ok: false, canceled: true }
      if (!('path' in picked)) return { ok: false, error: '请选择服务器上的保存路径' }
      return post('/api/config/export', { path: picked.path, parts: opts?.parts })
    },
    async pickConfigImport() {
      const picked = await requestPick({ mode: 'json', title: '选择配置文件' })
      if ('canceled' in picked) return { ok: false, canceled: true }
      if ('file' in picked) return uploadConfigFile(picked.file)
      return post('/api/config/inspect', { path: picked.path })
    },
    async inspectConfigImport(filePath: string) {
      return post('/api/config/inspect', { path: filePath })
    },
    async applyConfigImport(opts) {
      const res = await post('/api/config/apply', opts)
      if (res?.ok && res.layout) writeLocalLayout(res.layout)
      return res
    },
    async importConfig() {
      return api.pickConfigImport().then(async (picked) => {
        if (!picked.ok) return picked
        return api.applyConfigImport({ path: picked.path, keepLocalPaths: true })
      })
    },
    async pickDirectory(defaultPath?: string) {
      const picked = await requestPick({ mode: 'dir', title: '选择目录', start: defaultPath })
      if ('canceled' in picked || !('path' in picked)) return null
      return picked.path
    },
    async pickFfmpegPath(defaultPath?: string) {
      const picked = await requestPick({
        mode: 'ffmpeg',
        title: '选择 FFmpeg',
        start: defaultPath,
      })
      if ('canceled' in picked || !('path' in picked)) return null
      return picked.path
    },
    async listChannels() {
      return send('/api/channels')
    },
    async upsertChannel(channel) {
      return post('/api/channels/upsert', { channel })
    },
    async upsertChannels(channels) {
      return post('/api/channels/upsert-many', { channels })
    },
    async removeChannel(id) {
      return post('/api/channels/remove', { ids: [id] })
    },
    async removeChannels(ids) {
      return post('/api/channels/remove', { ids })
    },
    async moveChannelsToGroup(ids, groupName) {
      return post('/api/channels/move-group', { ids, group: groupName })
    },
    async moveChannelsBefore(ids, targetGroup, beforeId) {
      return post('/api/channels/move-before', { ids, targetGroup, beforeId })
    },
    async getGroupOrder() {
      return send('/api/groups')
    },
    async moveGroupBefore(groupName, beforeGroup) {
      return post('/api/groups/move', { group: groupName, before: beforeGroup })
    },
    async createGroup(name) {
      return post('/api/groups/create', { name })
    },
    async deleteGroup(name) {
      return post('/api/groups/delete', { name })
    },
    async renameGroup(from, to) {
      return post('/api/groups/rename', { from, to })
    },
    async dissolveGroup(name) {
      return post('/api/groups/dissolve', { name })
    },
    async getRuntimeStates() {
      return send('/api/states')
    },
    async startRecord(id) {
      return post('/api/record/start', { id })
    },
    async stopRecord(id) {
      return post('/api/record/stop', { id })
    },
    async stopAllRecords() {
      return post('/api/record/stop-all')
    },
    async startRecordGroup(groupName) {
      return post('/api/record/group/start', { group: groupName })
    },
    async stopRecordGroup(groupName) {
      return post('/api/record/group/stop', { group: groupName })
    },
    async startPreview(id) {
      if (!previewIds.includes(id)) {
        previewIds = [...previewIds, id].slice(0, 16)
      }
      return post('/api/preview/start', { id })
    },
    async stopPreview(id) {
      previewIds = previewIds.filter((x) => x !== id)
      const state = await post('/api/preview/stop', { id })
      // Drop from session want-list so the 10s heartbeat cannot revive it.
      try {
        await post('/api/previews', { channelIds: previewIds })
      } catch {
        /* ignore */
      }
      return state
    },
    async syncPreviews(ids) {
      previewIds = ids.slice(0, 16)
      return post('/api/previews', {
        channelIds: previewIds,
        hevcMse: browserSupportsHevcMse(),
      })
    },
    async reportClientCaps(caps) {
      return post('/api/client-caps', caps)
    },
    async listRecordings(channelId) {
      const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''
      return send('/api/recordings' + q)
    },
    async listSavedClips(channelId) {
      const q = channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''
      return send('/api/saved-clips' + q)
    },
    async preparePlaybackMedia(opts) {
      return post('/api/playback/prepare', opts)
    },
    async saveRecentClip(channelId, durationSec) {
      return post('/api/clips/save-recent', { channelId, durationSec })
    },
    async exportClipRange(opts) {
      let destPath = ''
      if (opts.pickPath) {
        const picked = await requestPick({
          mode: 'save',
          title: '另存为',
          saveName: 'clip.mp4',
        })
        if ('canceled' in picked) return { ok: false, canceled: true, error: '已取消' }
        if (!('path' in picked)) return { ok: false, error: '请选择服务器上的保存路径' }
        destPath = picked.path
      }
      return post('/api/clips/export', { ...opts, destPath })
    },
    async deleteSavedClip(segmentId) {
      return post('/api/clips/delete', { id: segmentId })
    },
    async revealSavedClips(channelId) {
      const info = await send('/api/app-info')
      await requestReveal(joinServer(info.savedClipsPath, channelId))
    },
    async revealItem(filePath) {
      await requestReveal(filePath)
    },
    async probeChannel(id) {
      return post('/api/probe', { id })
    },
    async scanDevices(opts) {
      return post('/api/scan', opts)
    },
    async listScanSubnets() {
      return send('/api/scan/subnets')
    },
    async cancelDeviceScan() {
      await post('/api/scan/cancel')
    },
    onScanProgress(cb) {
      scanListeners.add(cb)
      return () => scanListeners.delete(cb)
    },
    onWindowVisibility(cb) {
      visibilityListeners.add(cb)
      return () => visibilityListeners.delete(cb)
    },
    onPrepareMediaTeardown(cb) {
      teardownListeners.add(cb)
      return () => teardownListeners.delete(cb)
    },
    notifyMediaTeardownDone() {},
    async saveSnapshot(channelId, dataUrl) {
      return post('/api/snapshots', { channelId, dataUrl })
    },
    async revealRecordings(id) {
      const info = await send('/api/app-info')
      await requestReveal(joinServer(info.recordingsPath, id))
    },
    async revealSnapshots(id) {
      const info = await send('/api/app-info')
      await requestReveal(joinServer(info.snapshotsPath, id))
    },
    async getLayout() {
      const local = readLocalLayout()
      if (local) return sanitizeUiLayout(local as never)
      const remote = await send('/api/layout')
      writeLocalLayout(remote)
      return sanitizeUiLayout(remote)
    },
    async setLayout(layout) {
      const clean = sanitizeUiLayout(layout)
      writeLocalLayout(clean)
      void send('/api/layout', { method: 'PUT', body: JSON.stringify(clean) }).catch(() => undefined)
      return clean
    },
    async windowMinimize() {},
    async windowMaximize() {},
    async windowClose() {},
    async getWindowVisible() {
      return { visible: document.visibilityState !== 'hidden' }
    },
    async toggleDevTools() {
      return { open: false }
    },
    async getRemoteStatus() {
      return send('/api/remote/status')
    },
    async generateRemotePassword() {
      const res = await post('/api/remote/generate-password')
      return res.password as string
    },
    async ensureRemotePassword() {
      const info = await send('/api/status')
      return { password: '', username: info.username as string }
    },
    async getSystemService() {
      return send('/api/system-service')
    },
    async systemServiceAction(action) {
      return post('/api/system-service', { action })
    },
    watchTimeline(channelId: string) {
      watchChannelId = channelId || ''
      sendWatch()
    },
    onTimeline(cb) {
      timelineListeners.add(cb)
      return () => timelineListeners.delete(cb)
    },
    onRuntimeStates(cb) {
      stateListeners.add(cb)
      return () => stateListeners.delete(cb)
    },
    timelineFresh() {
      return Date.now() - lastTimelineAt < 3000
    },
  }
  return api
}
