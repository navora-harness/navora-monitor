import { contextBridge, ipcRenderer } from 'electron'
import type { NavoraMonitorApi } from '../shared/ipc-types'
import type { ChannelConfig } from '../shared/types'
import type { AppSettings } from '../shared/settings'
import type { UiLayoutState } from '../shared/panel-sizes'

const api: NavoraMonitorApi = {
  getAppInfo: () => ipcRenderer.invoke('nm:getAppInfo'),
  getSettings: () => ipcRenderer.invoke('nm:getSettings'),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('nm:setSettings', patch),
  getDiskSpace: () => ipcRenderer.invoke('nm:getDiskSpace'),
  runStorageCleanup: () => ipcRenderer.invoke('nm:runStorageCleanup'),
  clearAllLoopRecordings: () => ipcRenderer.invoke('nm:clearAllLoopRecordings'),
  onStorageAction: (cb) => {
    const listener = (_e: unknown, action: import('../shared/ipc-types').StorageAction) => cb(action)
    ipcRenderer.on('nm:storageAction', listener)
    return () => ipcRenderer.removeListener('nm:storageAction', listener)
  },
  onStorageChanged: (cb) => {
    const listener = (_e: unknown, info: import('../shared/ipc-types').DiskSpaceInfo) => cb(info)
    ipcRenderer.on('nm:storageChanged', listener)
    return () => ipcRenderer.removeListener('nm:storageChanged', listener)
  },
  repairConfig: (activePreviewIds?: string[]) => ipcRenderer.invoke('nm:repairConfig', activePreviewIds),
  exportConfig: (opts) => ipcRenderer.invoke('nm:exportConfig', opts?.parts),
  pickConfigImport: () => ipcRenderer.invoke('nm:pickConfigImport'),
  applyConfigImport: (opts) => ipcRenderer.invoke('nm:applyConfigImport', opts),
  importConfig: async () => {
    const picked = await ipcRenderer.invoke('nm:pickConfigImport')
    if (!picked?.ok) return picked
    return ipcRenderer.invoke('nm:applyConfigImport', {
      path: picked.path,
      parts: { channels: true, groupOrder: true, settings: true, layout: true },
      keepLocalPaths: true,
    })
  },
  pickDirectory: (defaultPath?: string) => ipcRenderer.invoke('nm:pickDirectory', defaultPath),
  pickFfmpegPath: (defaultPath?: string) => ipcRenderer.invoke('nm:pickFfmpegPath', defaultPath),
  listChannels: () => ipcRenderer.invoke('nm:listChannels'),
  upsertChannel: (channel: ChannelConfig) => ipcRenderer.invoke('nm:upsertChannel', channel),
  upsertChannels: (channels: ChannelConfig[]) => ipcRenderer.invoke('nm:upsertChannels', channels),
  removeChannel: (id: string) => ipcRenderer.invoke('nm:removeChannel', id),
  removeChannels: (ids: string[]) => ipcRenderer.invoke('nm:removeChannels', ids),
  moveChannelsToGroup: (ids: string[], groupName: string | null) =>
    ipcRenderer.invoke('nm:moveChannelsToGroup', ids, groupName),
  moveChannelsBefore: (ids: string[], targetGroup: string, beforeId: string | null) =>
    ipcRenderer.invoke('nm:moveChannelsBefore', ids, targetGroup, beforeId),
  getGroupOrder: () => ipcRenderer.invoke('nm:getGroupOrder'),
  moveGroupBefore: (groupName: string, beforeGroup: string | null) =>
    ipcRenderer.invoke('nm:moveGroupBefore', groupName, beforeGroup),
  createGroup: (name: string) => ipcRenderer.invoke('nm:createGroup', name),
  deleteGroup: (name: string) => ipcRenderer.invoke('nm:deleteGroup', name),
  renameGroup: (from: string, to: string) => ipcRenderer.invoke('nm:renameGroup', from, to),
  dissolveGroup: (name: string) => ipcRenderer.invoke('nm:dissolveGroup', name),
  getRuntimeStates: () => ipcRenderer.invoke('nm:getRuntimeStates'),
  startRecord: (id: string) => ipcRenderer.invoke('nm:startRecord', id),
  stopRecord: (id: string) => ipcRenderer.invoke('nm:stopRecord', id),
  stopAllRecords: () => ipcRenderer.invoke('nm:stopAllRecords'),
  startRecordGroup: (groupName: string) => ipcRenderer.invoke('nm:startRecordGroup', groupName),
  stopRecordGroup: (groupName: string) => ipcRenderer.invoke('nm:stopRecordGroup', groupName),
  startPreview: (id: string) => ipcRenderer.invoke('nm:startPreview', id),
  stopPreview: (id: string) => ipcRenderer.invoke('nm:stopPreview', id),
  syncPreviews: (ids: string[]) => ipcRenderer.invoke('nm:syncPreviews', ids),
  listRecordings: (channelId?: string) => ipcRenderer.invoke('nm:listRecordings', channelId),
  listSavedClips: (channelId?: string) => ipcRenderer.invoke('nm:listSavedClips', channelId),
  saveRecentClip: (channelId: string, durationSec?: number) =>
    ipcRenderer.invoke('nm:saveRecentClip', channelId, durationSec),
  deleteSavedClip: (segmentId: string) => ipcRenderer.invoke('nm:deleteSavedClip', segmentId),
  revealSavedClips: (channelId?: string) => ipcRenderer.invoke('nm:revealSavedClips', channelId),
  probeChannel: (id: string) => ipcRenderer.invoke('nm:probeChannel', id),
  scanDevices: (opts) => ipcRenderer.invoke('nm:scanDevices', opts),
  listScanSubnets: () => ipcRenderer.invoke('nm:listScanSubnets'),
  cancelDeviceScan: () => ipcRenderer.invoke('nm:cancelDeviceScan'),
  onScanProgress: (cb) => {
    const listener = (_e: unknown, p: import('../shared/ipc-types').DeviceScanProgress) => cb(p)
    ipcRenderer.on('nm:scanProgress', listener)
    return () => ipcRenderer.removeListener('nm:scanProgress', listener)
  },
  onWindowVisibility: (cb) => {
    const listener = (_e: unknown, p: { visible: boolean }) => cb(p)
    ipcRenderer.on('nm:windowVisibility', listener)
    return () => ipcRenderer.removeListener('nm:windowVisibility', listener)
  },
  saveSnapshot: (channelId: string, dataUrl: string) =>
    ipcRenderer.invoke('nm:saveSnapshot', channelId, dataUrl),
  revealRecordings: (id?: string) => ipcRenderer.invoke('nm:revealRecordings', id),
  revealSnapshots: (id?: string) => ipcRenderer.invoke('nm:revealSnapshots', id),
  getLayout: () => ipcRenderer.invoke('nm:getLayout'),
  setLayout: (layout: UiLayoutState) => ipcRenderer.invoke('nm:setLayout', layout),
  windowMinimize: () => ipcRenderer.invoke('nm:windowMinimize'),
  windowMaximize: () => ipcRenderer.invoke('nm:windowMaximize'),
  windowClose: () => ipcRenderer.invoke('nm:windowClose'),
  getRemoteStatus: () => ipcRenderer.invoke('nm:getRemoteStatus'),
  generateRemotePassword: () => ipcRenderer.invoke('nm:generateRemotePassword'),
  ensureRemotePassword: () => ipcRenderer.invoke('nm:ensureRemotePassword'),
}

contextBridge.exposeInMainWorld('navoraMonitor', api)
