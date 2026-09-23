import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import * as channelStore from './modules/channel-store'
import { channelRecordDir, channelSavedDir, ensureDir, getDataRoot, isRecordCacheActive, recordCacheRoot, recordingsRoot, savedClipsRoot, snapshotsRoot } from './modules/data-root'
import * as layoutStore from './modules/layout-store'
import { MediaServer } from './modules/media-server'
import { getPreviewRoot, PreviewManager } from './modules/preview-manager'
import { listRecordingSegments } from './modules/recording-index'
import { deleteSavedClip, listSavedClips, saveRecentClip } from './modules/saved-clips'
import { RecorderManager } from './modules/recorder-manager'
import { probeChannel } from './modules/ffmpeg/probe'
import { ScheduleRunner } from './modules/schedule-runner'
import { saveSnapshotJpeg } from './modules/snapshot-store'
import { loadAppIcon } from './modules/app-icon'
import { createAppTray, type TrayController } from './modules/tray'
import { loadSettings, saveSettings } from './modules/settings-store'
import { repairConfiguration } from './modules/repair-config'
import { exportConfigToFile, pickConfigImportFile, applyConfigImport } from './modules/config-transfer'
import { cancelDeviceScan, runDeviceScan, listScanSubnets } from './modules/device-scan'
import { StorageGuard } from './modules/storage-guard'
import { runRetentionCleanup } from './modules/retention'
import { RemoteServer } from './modules/remote-server'
import { generateSecurePassword, REMOTE_USERNAME } from '../shared/password'
import { channelGroup } from '../shared/groups'
import type { AppSettings } from '../shared/settings'
import type { ChannelConfig, ChannelRuntimeState } from '../shared/types'
import type { UiLayoutState } from '../shared/panel-sizes'

declare const __dirname: string

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
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
  getStaticRoot: () => join(__dirname, '../dist'),
  getViteDevUrl: () => process.env.VITE_DEV_SERVER_URL ?? null,
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

function createWindow() {
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
  mainWindow.on('blur', () => {
    /* keep playing while focused elsewhere but still visible */
  })

  mainWindow.on('close', (e) => {
    if (isQuitting) return
    if (loadSettings().closeToTray) {
      e.preventDefault()
      mainWindow?.hide()
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
  recorders.stopAll()
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
      name: 'Navora Monitor',
      version: packageVersion(),
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
    return { password: next.remotePassword, username: REMOTE_USERNAME }
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

  ipcMain.handle(
    'nm:applyConfigImport',
    async (
      _e,
      args: {
        path: string
        parts?: Partial<import('../shared/config-bundle').ConfigBundleParts>
        keepLocalPaths?: boolean
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
    if (slice.preview === 'live' || slice.preview === 'starting') {
      if (!channel.enabled) previews.stop(channel.id)
      else if (streamChanged) previews.restart(channel)
    } else if (!channel.enabled) {
      previews.stop(channel.id)
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
      if (slice.preview === 'live' || slice.preview === 'starting') {
        if (!channel.enabled) previews.stop(channel.id)
        else if (streamChanged) previews.restart(channel)
      } else if (!channel.enabled) {
        previews.stop(channel.id)
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

  ipcMain.handle('nm:deleteSavedClip', (_e, segmentId: string) => {
    return deleteSavedClip(segmentId)
  })

  ipcMain.handle('nm:revealSavedClips', (_e, id?: string) => {
    const dir = id ? channelSavedDir(id) : savedClipsRoot()
    ensureDir(dir)
    shell.openPath(dir)
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
    if (loadSettings().closeToTray) mainWindow?.hide()
    else quitApp()
  })
}

app.whenReady().then(async () => {
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
    onQuit: () => quitApp(),
  })
  scheduler.start(15_000)
  storage.start(15_000)
  void runRetentionCleanup()
  retentionTimer = setInterval(() => {
    void runRetentionCleanup()
  }, 60 * 60 * 1000)
})

app.on('second-instance', () => {
  tray?.showMain()
})

app.on('before-quit', () => {
  isQuitting = true
  void remote.stop()
  previews.stopAll()
  recorders.stopAll()
  scheduler.stop()
  storage.stopTimer()
  if (retentionTimer) clearInterval(retentionTimer)
  media.stop()
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
})
