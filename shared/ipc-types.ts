import type {
  AppInfo,
  ChannelConfig,
  ChannelRuntimeState,
  ProbeResult,
  RecordingSegment,
  StartPreviewResult,
  StartRecordResult,
  StopRecordResult,
} from './types'
import type { AppSettings } from './settings'
import type { PanelSizes, UiLayoutState } from './panel-sizes'
import type { StorageLevel } from './storage-policy'

export type StorageAction = {
  type: 'cleanup' | 'stop' | 'block' | 'capacity'
  message: string
  deleted?: number
  freedBytes?: number
  at: number
}

export type DiskSpaceInfo = {
  path: string
  freeBytes: number
  totalBytes: number
  freeRatio: number
  recordingsBytes: number
  /** Bytes occupied by user-saved (protected) clips */
  savedClipsBytes: number
  /** Observed aggregate write rate of active recordings (bytes/sec); 0 if unknown */
  writeBytesPerSec: number
  /** Free space ÷ write rate — how long continuous recording can continue */
  estimatedRemainSec: number | null
  /** Bytes needed for retentionDays at current write rate; null if N/A */
  retentionNeedBytes: number | null
  retentionDays: number
  /** False when preset retention window would exceed remaining free space */
  retentionFit: boolean
  level: StorageLevel
  recordingBlocked: boolean
  warn: boolean
  stop: boolean
  autoCleanup: boolean
  lastAction: StorageAction | null
}

export type GroupRecordResult = {
  ok: boolean
  started: number
  total: number
  errors: string[]
  states: ChannelRuntimeState[]
}

export type DiscoveredCamera = {
  id: string
  host: string
  port: number
  openPorts: number[]
  source: 'onvif' | 'lan'
  manufacturer?: string
  model?: string
  name?: string
  presetId: string
  suggestedUrl: string
  suggestedPreviewUrl: string
}

export type ScanSubnetInfo = {
  cidr: string
  address: string
  iface: string
  recommended: boolean
  virtual: boolean
}

export type DeviceScanProgress = {
  done: number
  total: number
  message: string
}

export type DeviceScanRequest = {
  mode: 'auto' | 'onvif' | 'lan'
  cidr?: string
  username?: string
  password?: string
  /** When LAN only finds RTSP 554, use this vendor URL preset (e.g. ezviz). */
  preferredPresetId?: string
}

export type ConfigBundleParts = {
  channels: boolean
  groupOrder: boolean
  settings: boolean
  layout: boolean
}

export type NavoraMonitorApi = {
  getAppInfo: () => Promise<AppInfo>
  openExternal: (url: string) => Promise<{ ok: boolean }>
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  getDiskSpace: () => Promise<DiskSpaceInfo | null>
  runStorageCleanup: () => Promise<DiskSpaceInfo | null>
  clearAllLoopRecordings: () => Promise<DiskSpaceInfo | null>
  onStorageAction: (cb: (action: StorageAction) => void) => () => void
  onStorageChanged: (cb: (info: DiskSpaceInfo) => void) => () => void
  repairConfig: (activePreviewIds?: string[]) => Promise<{
    ok: boolean
    messages: string[]
    channelCount: number
  }>
  /**
   * Normalize A/V timestamps on existing finished .ts recordings (stream copy).
   * Skips files still being written; only remuxes when PTS skew is detected (unless force).
   */
  repairRecordingTimestamps: (opts?: {
    channelId?: string
    force?: boolean
  }) => Promise<{
    ok: true
    scanned: number
    needed: number
    repaired: number
    skipped: number
    failed: number
    message: string
  }>
  exportConfig: (opts?: { parts?: ConfigBundleParts }) => Promise<
    | { ok: true; path: string; channelCount: number; parts?: ConfigBundleParts }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  pickConfigImport: () => Promise<
    | {
        ok: true
        path: string
        summary: string
        exportedAt: string
        available: ConfigBundleParts
        channelCount: number
        channels: Array<{ id: string; name: string; group: string }>
      }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  /** Inspect a config JSON at an absolute path (e.g. after drag-drop). */
  inspectConfigImport: (filePath: string) => Promise<
    | {
        ok: true
        path: string
        summary: string
        exportedAt: string
        available: ConfigBundleParts
        channelCount: number
        channels: Array<{ id: string; name: string; group: string }>
      }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  applyConfigImport: (opts: {
    path: string
    parts?: ConfigBundleParts
    keepLocalPaths?: boolean
    channelIds?: string[]
  }) => Promise<
    | {
        ok: true
        path: string
        channelCount: number
        keptLocalPaths: boolean
        parts?: ConfigBundleParts
        channels: ChannelConfig[]
        groupOrder: string[]
        settings: AppSettings
        layout: UiLayoutState
      }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  /** @deprecated prefer pickConfigImport + applyConfigImport */
  importConfig: () => Promise<
    | {
        ok: true
        path: string
        channelCount: number
        keptLocalPaths: boolean
        channels: ChannelConfig[]
        groupOrder: string[]
        settings: AppSettings
        layout: UiLayoutState
      }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  pickDirectory: (defaultPath?: string) => Promise<string | null>
  pickFfmpegPath: (defaultPath?: string) => Promise<string | null>
  listChannels: () => Promise<ChannelConfig[]>
  upsertChannel: (channel: ChannelConfig) => Promise<ChannelConfig[]>
  upsertChannels: (channels: ChannelConfig[]) => Promise<ChannelConfig[]>
  removeChannel: (id: string) => Promise<ChannelConfig[]>
  removeChannels: (ids: string[]) => Promise<ChannelConfig[]>
  moveChannelsToGroup: (ids: string[], groupName: string | null) => Promise<ChannelConfig[]>
  moveChannelsBefore: (
    ids: string[],
    targetGroup: string,
    beforeId: string | null,
  ) => Promise<ChannelConfig[]>
  getGroupOrder: () => Promise<string[]>
  moveGroupBefore: (groupName: string, beforeGroup: string | null) => Promise<string[]>
  createGroup: (name: string) => Promise<string[]>
  deleteGroup: (name: string) => Promise<string[]>
  renameGroup: (from: string, to: string) => Promise<ChannelConfig[]>
  dissolveGroup: (name: string) => Promise<ChannelConfig[]>
  getRuntimeStates: () => Promise<ChannelRuntimeState[]>
  startRecord: (id: string) => Promise<StartRecordResult>
  stopRecord: (id: string) => Promise<StopRecordResult>
  stopAllRecords: () => Promise<ChannelRuntimeState[]>
  startRecordGroup: (groupName: string) => Promise<GroupRecordResult>
  stopRecordGroup: (groupName: string) => Promise<ChannelRuntimeState[]>
  startPreview: (id: string) => Promise<StartPreviewResult>
  stopPreview: (id: string) => Promise<ChannelRuntimeState>
  syncPreviews: (ids: string[]) => Promise<ChannelRuntimeState[]>
  listRecordings: (channelId?: string) => Promise<RecordingSegment[]>
  listSavedClips: (channelId?: string) => Promise<RecordingSegment[]>
  preparePlaybackMedia: (opts: {
    channelId: string
    fileName: string
    kind?: 'recordings' | 'saved'
  }) => Promise<
    | { ok: true; url: string; fileName: string; cached: boolean }
    | { ok: false; error: string }
  >
  saveRecentClip: (
    channelId: string,
    durationSec?: number,
  ) => Promise<
    | { ok: true; copied: number; durationSec: number; message: string; clips: RecordingSegment[] }
    | { ok: false; error: string }
  >
  exportClipRange: (opts: {
    channelId: string
    startMs: number
    endMs: number
    /** If true, show Save As dialog; otherwise write under SavedClips */
    pickPath?: boolean
  }) => Promise<
    | {
        ok: true
        path: string
        fileName: string
        channelId: string
        startMs: number
        endMs: number
        segmentCount: number
        message: string
      }
    | { ok: false; error: string; canceled?: true }
  >
  deleteSavedClip: (segmentId: string) => Promise<{ ok: true } | { ok: false; error: string }>
  revealSavedClips: (channelId?: string) => Promise<void>
  /** Reveal a file in the OS file manager (selected). */
  revealItem: (filePath: string) => Promise<void>
  probeChannel: (id: string) => Promise<ProbeResult>
  scanDevices: (opts: DeviceScanRequest) => Promise<
    | { ok: true; cameras: DiscoveredCamera[]; durationMs: number; scannedHosts: number }
    | { ok: false; canceled: true }
    | { ok: false; error: string }
  >
  listScanSubnets: () => Promise<ScanSubnetInfo[]>
  cancelDeviceScan: () => Promise<void>
  onScanProgress: (cb: (p: DeviceScanProgress) => void) => () => void
  onWindowVisibility: (cb: (p: { visible: boolean }) => void) => () => void
  saveSnapshot: (
    channelId: string,
    dataUrl: string,
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
  revealRecordings: (id?: string) => Promise<void>
  revealSnapshots: (id?: string) => Promise<void>
  getLayout: () => Promise<UiLayoutState>
  setLayout: (layout: UiLayoutState) => Promise<UiLayoutState>
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  /** Toggle Chromium DevTools (detached). */
  toggleDevTools: () => Promise<{ open: boolean }>
  getRemoteStatus: () => Promise<RemoteAccessStatus>
  generateRemotePassword: () => Promise<string>
  ensureRemotePassword: () => Promise<{ password: string; username: string }>
}

export type RemoteAccessStatus = {
  enabled: boolean
  listening: boolean
  port: number
  urls: string[]
  username: string
  error: string | null
}

export type { PanelSizes, UiLayoutState, AppSettings }
