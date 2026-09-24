import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import * as channelStore from './modules/channel-store'
import { channelRecordDir, channelSavedDir, ensureDir, getDataRoot, isRecordCacheActive, recordCacheRoot, recordingsRoot, savedClipsRoot, snapshotsRoot } from './modules/data-root'
import * as layoutStore from './modules/layout-store'
import { MediaServer } from './modules/media-server'
import {
  registerMediaProtocolHandler,
  registerMediaSchemePrivileged,
} from './modules/media-protocol'
import { getPreviewRoot, PreviewManager } from './modules/preview-manager'
import { listRecordingSegments } from './modules/recording-index'
import { deleteSavedClip, listSavedClips, saveRecentClip } from './modules/saved-clips'
import { exportClipRange } from './modules/export-clip'
import { formatExportStamp } from '../shared/export-clip'
import { RecorderManager } from './modules/recorder-manager'
import { probeChannel } from './modules/ffmpeg/probe'
import { ScheduleRunner } from './modules/schedule-runner'
import { saveSnapshotJpeg } from './modules/snapshot-store'
import { loadAppIcon } from './modules/app-icon'
import { createAppTray, type TrayController } from './modules/tray'
import { loadSettings, saveSettings } from './modules/settings-store'
import { applyOpenAtLogin } from './modules/login-item'
import { repairConfiguration } from './modules/repair-config'
import { exportConfigToFile, pickConfigImportFile, inspectConfigImportFile, applyConfigImport } from './modules/config-transfer'
import { cancelDeviceScan, runDeviceScan, listScanSubnets } from './modules/device-scan'
import { StorageGuard } from './modules/storage-guard'
import { runRetentionCleanup } from './modules/retention'
import { RemoteServer } from './modules/remote-server'
import { generateSecurePassword } from '../shared/password'
import { channelGroup } from '../shared/groups'
import {
  APP_COPYRIGHT,
  APP_HOMEPAGE,
  APP_LICENSE,
  APP_LICENSE_NOTE,
  APP_NAME,
} from '../shared/app-meta'
import type { AppSettings } from '../shared/settings'
import type { ChannelConfig, ChannelRuntimeState } from '../shared/types'
import type { UiLayoutState } from '../shared/panel-sizes'

declare const __dirname: string

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Must run before app.whenReady()
  registerMediaSchemePrivileged()
}

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let isQuitting = false
let retentionTimer: ReturnType<typeof setInterval> | null = null
const media = new MediaServer()
const recorders = new RecorderManager()
const previews = new PreviewManager(media)
const storage = new StorageGuard({
  recorders,
  getWindow: () => mainWindow,
})
const scheduler = new ScheduleRunner({
  recorders,
  loadChannels: () => channelStore.loadChannels(),
  storage,
})
const remote = new RemoteServer({
  media,
  previews,
  loadChannels: () => channelStore.loadChannels(),
  getGroupOrder: () => channelStore.loadGroupOrder(),
  mergeState,
  allStates,
  listRecordings: (channelId?: string) => {
    const seg = loadSettings().defaultSegmentTimeSec || 300
    return listRecordingSegments(media, channelId, seg)
  },
  listSavedClips: (channelId?: string) => listSavedClips(media, channelId),
  getStaticRoot: () => join(__dirname, '../dist'),
  getViteDevUrl: () => process.env.VITE_DEV_SERVER_URL ?? null,
  getAppMeta: () => ({
    name: APP_NAME,
    version: packageVersion(),
    license: APP_LICENSE,
    copyright: APP_COPYRIGHT,
    homepage: APP_HOMEPAGE,
    licenseNote: APP_LICENSE_NOTE,
  }),
})

function ensureRemotePassword(settings: AppSettings): AppSettings {
  if (!settings.remoteEnabled) return settings
  if (settings.remotePassword.trim()) return settings
  return saveSettings({ remotePassword: generateSecurePassword(16) })
}

function mergeState(channelId: string): ChannelRuntimeState {
  const rec = recorders.getState(channelId)
  const prev = previews.getPreviewSlice(channelId)
  return { ...rec, ...prev, id: channelId }
}

function allStates(): ChannelRuntimeState[] {
  return channelStore.loadChannels().map((c) => mergeState(c.id))
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return

  ensureDir(getDataRoot())
  ensureDir(recordingsRoot())
  ensureDir(snapshotsRoot())
  media.setPreviewRoot(getPreviewRoot())

  const settings = loadSettings()
  const appIcon = loadAppIcon()
  const darkUi =
    settings.uiTheme === 'dark' ||
    (settings.uiTheme === 'system' && nativeTheme.shouldUseDarkColors)
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Navora Monitor',
    show: false,
    backgroundColor: darkUi ? '#141920' : '#f3f3f3',
    frame: false,
    titleBarStyle: 'hidden',
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  Menu.setApplicationMenu(null)

  const notifyVisibility = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const visible = mainWindow.isVisible() && !mainWindow.isMinimized()
    mainWindow.webContents.send('nm:windowVisibility', { visible })
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
    if (process.env.NAVORA_MONITOR_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    void mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    if (settings.showMainOnStartup) mainWindow?.show()
    notifyVisibility()
  })

  mainWindow.on('show', notifyVisibility)
  mainWindow.on('hide', notifyVisibility)
  mainWindow.on('minimize', notifyVisibility)
  mainWindow.on('restore', notifyVisibility)
  mainWindow.on('focus', notifyVisibility)

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const toggle =
      key === 'f12' || (key === 'i' && input.control && input.shift && !input.alt && !input.meta)
    if (!toggle) return
    event.preventDefault()
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed()) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  })
  mainWindow.on('blur', () => {
    /* keep playing while focused elsewhere but still visible */
  })

  mainWindow.on('close', (e) => {
    if (isQuitting) return
    if (loadSettings().closeToTray) {
      e.preventDefault()
      hideMainWindow()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function quitApp() {
  isQuitting = true
  void remote.stop()
  previews.stopAll()
  // Keep remembered recording ids so next launch can resume
  recorders.stopAll({ forget: false })
  scheduler.stop()
  storage.stopTimer()
  if (retentionTimer) clearInterval(retentionTimer)
  media.stop()
  tray?.destroy()
  app.quit()
}

function registerIpc() {
  ipcMain.handle('nm:getAppInfo', () => {
    const ff = recorders.getFfmpegInfo()
    const s = loadSettings()
    return {
      name: APP_NAME,
      version: packageVersion(),
      license: APP_LICENSE,
      copyright: APP_COPYRIGHT,
      homepage: APP_HOMEPAGE,
      licenseNote: APP_LICENSE_NOTE,
      dataRoot: getDataRoot(),
      recordingsPath: recordingsRoot(),
      snapshotsPath: snapshotsRoot(),
      savedClipsPath: savedClipsRoot(),
      recordCachePath: recordCacheRoot(),
      recordCacheActive: isRecordCacheActive(),
      ffmpegPath: ff.path,
      ffmpegOk: ff.ok,
      mediaBaseUrl: media.baseUrl,
      defaultSegmentTimeSec: s.defaultSegmentTimeSec,
      savedClipDurationSec: s.savedClipDurationSec,
    }
  })

  ipcMain.handle('nm:openExternal', (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false as const }
    void shell.openExternal(url)
    return { ok: true as const }
  })

  ipcMain.handle('nm:getSettings', () => loadSettings())

  ipcMain.handle('nm:getDiskSpace', () => storage.tick())

  ipcMain.handle('nm:runStorageCleanup', () => storage.forceCleanup())

  ipcMain.handle('nm:clearAllLoopRecordings', () => storage.clearAllLoopRecordings())

  ipcMain.handle('nm:setSettings', async (_e, patch: Partial<AppSettings>) => {
    let next = saveSettings(patch)
    next = ensureRemotePassword(next)
    ensureDir(recordingsRoot())
    ensureDir(snapshotsRoot())
    ensureDir(savedClipsRoot())
    recorders.refreshFfmpeg()
    previews.refreshFfmpeg()
    applyOpenAtLogin(next)
    try {
      await remote.applyFromSettings()
    } catch {
      /* status.error set inside RemoteServer */
    }
    return next
  })

  ipcMain.handle('nm:getRemoteStatus', () => remote.getStatus())

  ipcMain.handle('nm:generateRemotePassword', () => generateSecurePassword(16))

  ipcMain.handle('nm:ensureRemotePassword', () => {
    const next = ensureRemotePassword(loadSettings())
    return { password: next.remotePassword, username: next.remoteUsername }
  })

  ipcMain.handle('nm:repairConfig', (_e, activePreviewIds?: string[]) => {
    return repairConfiguration({
      recorders,
      previews,
      activePreviewIds,
    })
  })

  ipcMain.handle('nm:exportConfig', (_e, parts?: Partial<import('../shared/config-bundle').ConfigBundleParts>) =>
    exportConfigToFile(mainWindow, parts),
  )

  ipcMain.handle('nm:pickConfigImport', () => pickConfigImportFile(mainWindow))
  ipcMain.handle('nm:inspectConfigImport', (_e, filePath: string) => inspectConfigImportFile(filePath))

  ipcMain.handle(
    'nm:applyConfigImport',
    async (
      _e,
      args: {
        path: string
        parts?: Partial<import('../shared/config-bundle').ConfigBundleParts>
        keepLocalPaths?: boolean
        channelIds?: string[]
      },
    ) => {
      const result = await applyConfigImport(mainWindow, args ?? { path: '' }, { recorders, previews })
      if (result.ok && args?.parts?.settings !== false) {
        ensureRemotePassword(loadSettings())
        try {
          await remote.applyFromSettings()
        } catch {
          /* status.error set inside RemoteServer */
        }
      }
      return result
    },
  )

  ipcMain.handle('nm:pickDirectory', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({
      title: '选择目录',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('nm:pickFfmpegPath', async (_e, defaultPath?: string) => {
    const res = await dialog.showOpenDialog({
      title: '选择 FFmpeg',
      defaultPath: defaultPath || undefined,
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'ffmpeg', extensions: ['exe'] }]
          : [{ name: 'All', extensions: ['*'] }],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('nm:listChannels', () => channelStore.loadChannels())

  ipcMain.handle('nm:upsertChannel', (_e, channel: ChannelConfig) => {
    const prev = channelStore.loadChannels().find((c) => c.id === channel.id)
    const list = channelStore.upsertChannel(channel)
    const slice = previews.getPreviewSlice(channel.id)
    const streamChanged =
      !prev ||
      prev.url !== channel.url ||
      (prev.previewUrl ?? '') !== (channel.previewUrl ?? '') ||
      (prev.rtspTransport ?? 'tcp') !== (channel.rtspTransport ?? 'tcp') ||
      prev.enabled !== channel.enabled
    if (!channel.enabled) {
      previews.stop(channel.id)
      recorders.stop(channel.id)
    } else if (slice.preview === 'live' || slice.preview === 'starting') {
      if (streamChanged) previews.restart(channel)
    }
    return list
  })

  ipcMain.handle('nm:upsertChannels', (_e, channels: ChannelConfig[]) => {
    const before = new Map(channelStore.loadChannels().map((c) => [c.id, c]))
    const list = channelStore.upsertChannels(channels)
    for (const channel of channels) {
      const prev = before.get(channel.id)
      const slice = previews.getPreviewSlice(channel.id)
      const streamChanged =
        !prev ||
        prev.url !== channel.url ||
        (prev.previewUrl ?? '') !== (channel.previewUrl ?? '') ||
        (prev.rtspTransport ?? 'tcp') !== (channel.rtspTransport ?? 'tcp') ||
        prev.enabled !== channel.enabled
      if (!channel.enabled) {
        previews.stop(channel.id)
        recorders.stop(channel.id)
      } else if (slice.preview === 'live' || slice.preview === 'starting') {
        if (streamChanged) previews.restart(channel)
      }
    }
    return list
  })

  ipcMain.handle('nm:removeChannel', (_e, id: string) => {
    previews.stop(id)
    recorders.stop(id)
    return channelStore.removeChannel(id)
  })

  ipcMain.handle('nm:removeChannels', (_e, ids: string[]) => {
    for (const id of ids) {
      previews.stop(id)
      recorders.stop(id)
    }
    return channelStore.removeChannels(ids)
  })

  ipcMain.handle('nm:moveChannelsToGroup', (_e, ids: string[], groupName: string | null) =>
    channelStore.moveChannelsToGroup(ids, groupName),
  )

  ipcMain.handle(
    'nm:moveChannelsBefore',
    (_e, ids: string[], targetGroup: string, beforeId: string | null) =>
      channelStore.moveChannelsBefore(ids, targetGroup, beforeId),
  )

  ipcMain.handle('nm:getGroupOrder', () => channelStore.loadGroupOrder())

  ipcMain.handle('nm:moveGroupBefore', (_e, groupName: string, beforeGroup: string | null) =>
    channelStore.moveGroupBefore(groupName, beforeGroup),
  )

  ipcMain.handle('nm:createGroup', (_e, name: string) => channelStore.createGroup(name))

  ipcMain.handle('nm:deleteGroup', (_e, name: string) => channelStore.deleteGroup(name))

  ipcMain.handle('nm:renameGroup', (_e, from: string, to: string) => channelStore.renameGroup(from, to))

  ipcMain.handle('nm:dissolveGroup', (_e, name: string) => channelStore.dissolveGroup(name))

  ipcMain.handle('nm:getRuntimeStates', () => allStates())

  ipcMain.handle('nm:startRecord', async (_e, id: string) => {
    const gate = await storage.ensureRecordAllowed()
    if (!gate.ok) return { ok: false as const, error: gate.error }
    const ch = channelStore.loadChannels().find((c) => c.id === id)
    if (!ch) return { ok: false as const, error: '通道不存在' }
    if (!ch.enabled) return { ok: false as const, error: '通道已停用' }
    const started = recorders.start(ch)
    const merged = { ...started, ...previews.getPreviewSlice(id) }
    if (merged.recording === 'error') return { ok: false as const, error: merged.lastError ?? '启动失败', state: merged }
    return { ok: true as const, state: merged }
  })

  ipcMain.handle('nm:stopRecord', (_e, id: string) => {
    recorders.stop(id)
    return { ok: true as const, state: mergeState(id) }
  })

  ipcMain.handle('nm:stopAllRecords', () => {
    recorders.stopAll()
    return allStates()
  })

  ipcMain.handle('nm:startRecordGroup', async (_e, groupName: string) => {
    const gate = await storage.ensureRecordAllowed()
    if (!gate.ok) {
      return {
        ok: false,
        started: 0,
        total: 0,
        errors: [gate.error],
        states: allStates(),
      }
    }
    const list = channelStore.loadChannels().filter((c) => c.enabled && channelGroup(c) === groupName)
    let started = 0
    const errors: string[] = []
    for (const ch of list) {
      const state = recorders.start(ch)
      if (state.recording === 'recording') started += 1
      else if (state.recording === 'error' && state.lastError) errors.push(`${ch.id}: ${state.lastError}`)
    }
    return { ok: errors.length === 0, started, total: list.length, errors, states: allStates() }
  })

  ipcMain.handle('nm:stopRecordGroup', (_e, groupName: string) => {
    const list = channelStore.loadChannels().filter((c) => channelGroup(c) === groupName)
    for (const ch of list) recorders.stop(ch.id)
    return allStates()
  })

  ipcMain.handle('nm:startPreview', (_e, id: string) => {
    const ch = channelStore.loadChannels().find((c) => c.id === id)
    if (!ch) return { ok: false as const, error: '通道不存在' }
    const slice = previews.start(ch)
    const state = { ...recorders.getState(id), ...slice }
    if (slice.preview === 'error') return { ok: false as const, error: slice.previewError ?? '预览失败', state }
    return { ok: true as const, state }
  })

  ipcMain.handle('nm:stopPreview', (_e, id: string) => {
    previews.stop(id)
    return mergeState(id)
  })

  ipcMain.handle('nm:syncPreviews', (_e, ids: string[]) => {
    const list = channelStore.loadChannels()
    previews.syncDesktop(ids, (id) => list.find((c) => c.id === id))
    return allStates()
  })

  ipcMain.handle('nm:listRecordings', (_e, channelId?: string) => {
    const channels = channelStore.loadChannels()
    const settings = loadSettings()
    const seg =
      channelId != null
        ? channels.find((c) => c.id === channelId)?.segmentTimeSec ?? settings.defaultSegmentTimeSec
        : settings.defaultSegmentTimeSec
    return listRecordingSegments(media, channelId, seg)
  })

  ipcMain.handle('nm:listSavedClips', (_e, channelId?: string) => {
    return listSavedClips(media, channelId)
  })

  ipcMain.handle('nm:saveRecentClip', (_e, channelId: string, durationSec?: number) => {
    const ch = channelStore.loadChannels().find((c) => c.id === channelId)
    if (!ch) return { ok: false as const, error: '通道不存在' }
    const res = saveRecentClip(channelId, durationSec)
    if (!res.ok) return res
    const clips = res.clips.map((c) => ({
      ...c,
      url: media.savedClipUrl(c.channelId, c.fileName),
    }))
    return {
      ok: true as const,
      copied: res.copied,
      durationSec: res.durationSec,
      message: res.message,
      clips,
    }
  })

  ipcMain.handle(
    'nm:exportClipRange',
    async (
      _e,
      opts: { channelId: string; startMs: number; endMs: number; pickPath?: boolean },
    ) => {
      const channelId = typeof opts?.channelId === 'string' ? opts.channelId : ''
      const ch = channelStore.loadChannels().find((c) => c.id === channelId)
      if (!ch) return { ok: false as const, error: '通道不存在' }
      const startMs = Number(opts.startMs)
      const endMs = Number(opts.endMs)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return { ok: false as const, error: '时间范围无效' }
      }

      let outputPath: string | undefined
      if (opts.pickPath) {
        const a = Math.min(startMs, endMs)
        const b = Math.max(startMs, endMs)
        const defaultName = `Export_${formatExportStamp(a)}_${formatExportStamp(b)}.mp4`
        const picked = await dialog.showSaveDialog(mainWindow ?? undefined, {
          title: '导出合并片段',
          defaultPath: join(channelSavedDir(channelId), defaultName),
          filters: [{ name: 'MP4', extensions: ['mp4'] }],
        })
        if (picked.canceled || !picked.filePath) {
          return { ok: false as const, error: '已取消', canceled: true as const }
        }
        outputPath = picked.filePath.toLowerCase().endsWith('.mp4')
          ? picked.filePath
          : `${picked.filePath}.mp4`
      }

      return exportClipRange({ channelId, startMs, endMs, outputPath })
    },
  )

  ipcMain.handle('nm:deleteSavedClip', (_e, segmentId: string) => {
    return deleteSavedClip(segmentId)
  })

  ipcMain.handle('nm:revealSavedClips', (_e, id?: string) => {
    const dir = id ? channelSavedDir(id) : savedClipsRoot()
    ensureDir(dir)
    shell.openPath(dir)
  })

  /** Open Explorer/Finder with the file selected (falls back to parent dir). */
  ipcMain.handle('nm:revealItem', (_e, filePath?: string) => {
    if (typeof filePath !== 'string' || !filePath.trim()) return
    const p = filePath.trim()
    if (existsSync(p)) {
      shell.showItemInFolder(p)
      return
    }
    const dir = dirname(p)
    if (dir && existsSync(dir)) {
      ensureDir(dir)
      shell.openPath(dir)
    }
  })

  ipcMain.handle('nm:probeChannel', async (_e, id: string) => {
    const ch = channelStore.loadChannels().find((c) => c.id === id)
    if (!ch) return { ok: false as const, error: '通道不存在', latencyMs: 0 }
    return probeChannel(ch)
  })

  ipcMain.handle('nm:listScanSubnets', () => listScanSubnets())

  ipcMain.handle(
    'nm:scanDevices',
    async (
      _e,
      opts: {
        mode: 'auto' | 'onvif' | 'lan'
        cidr?: string
        username?: string
        password?: string
        preferredPresetId?: string
      },
    ) => {
      const mode = opts?.mode === 'lan' || opts?.mode === 'onvif' ? opts.mode : 'auto'
      return runDeviceScan({
        mode,
        cidr: opts?.cidr,
        username: opts?.username,
        password: opts?.password,
        preferredPresetId: opts?.preferredPresetId,
        onProgress: (done, total, message) => {
          mainWindow?.webContents.send('nm:scanProgress', { done, total, message })
        },
      })
    },
  )

  ipcMain.handle('nm:cancelDeviceScan', () => {
    cancelDeviceScan()
  })

  ipcMain.handle('nm:saveSnapshot', (_e, channelId: string, dataUrl: string) => {
    return saveSnapshotJpeg(channelId, dataUrl)
  })

  ipcMain.handle('nm:revealRecordings', (_e, id?: string) => {
    const dir = id ? channelRecordDir(id) : recordingsRoot()
    ensureDir(dir)
    shell.openPath(dir)
  })

  ipcMain.handle('nm:revealSnapshots', (_e, id?: string) => {
    const dir = id ? join(snapshotsRoot(), id) : snapshotsRoot()
    ensureDir(dir)
    shell.openPath(dir)
  })

  ipcMain.handle('nm:getLayout', () => layoutStore.loadLayout())

  ipcMain.handle('nm:setLayout', (_e, layout: UiLayoutState) => layoutStore.saveLayout(layout))

  ipcMain.handle('nm:windowMinimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('nm:windowMaximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('nm:windowClose', () => {
    if (loadSettings().closeToTray) hideMainWindow()
    else quitApp()
  })
  ipcMain.handle('nm:toggleDevTools', () => {
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed()) return { open: false }
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
      return { open: false }
    }
    wc.openDevTools({ mode: 'detach' })
    return { open: true }
  })
}

app.whenReady().then(async () => {
  registerMediaProtocolHandler()
  let settings = loadSettings()
  settings = ensureRemotePassword(settings)
  recorders.refreshFfmpeg()
  previews.refreshFfmpeg()
  media.setPreviewRoot(getPreviewRoot())
  await media.start()
  try {
    await remote.applyFromSettings()
  } catch {
    /* remote status.error populated */
  }
  registerIpc()
  createWindow()
  tray = createAppTray({
    getMainWindow: () => mainWindow,
    ensureMainWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    },
    onQuit: () => quitApp(),
    initialIconVisible: true,
  })
  applyOpenAtLogin(loadSettings())
  // Resume manual recordings from last session (before schedule tick)
  const resolveChannel = (id: string) => channelStore.loadChannels().find((c) => c.id === id)
  recorders.setChannelResolver(resolveChannel)

  const tryResumeRemembered = async (reason: string) => {
    const gate = await storage.ensureRecordAllowed()
    if (!gate.ok) {
      console.log(`[recording] resume deferred (${reason}): ${gate.error}`)
      return
    }
    const resumed = recorders.resumeRemembered(resolveChannel)
    if (resumed.started > 0) {
      console.log(`[recording] resumed ${resumed.started} channel(s) (${reason})`)
    }
    if (resumed.errors.length) {
      console.warn(`[recording] resume issues: ${resumed.errors.slice(0, 3).join('; ')}`)
    }
  }

  await tryResumeRemembered('startup')
  scheduler.start(15_000)
  storage.start(15_000)
  // Retry remembered recordings periodically (disk was full / ffmpeg race / crash)
  setInterval(() => {
    void tryResumeRemembered('periodic')
  }, 30_000)
  void runRetentionCleanup()
  retentionTimer = setInterval(() => {
    void runRetentionCleanup()
  }, 60 * 60 * 1000)
})

app.on('second-instance', () => {
  showMainWindow()
})

app.on('activate', () => {
  // macOS dock click
  showMainWindow()
})

app.on('before-quit', () => {
  isQuitting = true
  void remote.stop()
  previews.stopAll()
  recorders.stopAll({ forget: false })
  scheduler.stop()
  storage.stopTimer()
  if (retentionTimer) clearInterval(retentionTimer)
  media.stop()
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  // Keep running only while close-to-tray leaves a hidden window.
  // If the window was actually destroyed, quit (tray icon alone is not enough).
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!isQuitting) quitApp()
  }
})
