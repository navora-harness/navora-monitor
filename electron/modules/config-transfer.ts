import { app, BrowserWindow, dialog } from 'electron'
import { writeFileSync, readFileSync } from 'node:fs'
import {
  CONFIG_BUNDLE_KIND,
  configBundleAvailableParts,
  configBundleSummary,
  describeConfigParts,
  mergeSettingsKeepingLocalPaths,
  sanitizeConfigBundle,
  sanitizeConfigParts,
  stripMachineLocalSettings,
  type ConfigBundle,
  type ConfigBundleParts,
  DEFAULT_CONFIG_PARTS,
} from '../../shared/config-bundle'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import { DEFAULT_GROUP, channelGroup } from '../../shared/groups'
import { defaultUiLayout, type UiLayoutState } from '../../shared/panel-sizes'
import * as channelStore from './channel-store'
import * as layoutStore from './layout-store'
import { loadSettings, replaceSettings } from './settings-store'
import { ensureDir, recordingsRoot, savedClipsRoot, snapshotsRoot } from './data-root'
import { findStorageNestConflict } from '../../shared/storage-path'
import type { PreviewManager } from './preview-manager'
import type { RecorderManager } from './recorder-manager'

export type ExportConfigResult =
  | { ok: true; path: string; channelCount: number; parts: ConfigBundleParts }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

export type PickConfigImportResult =
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

export type ImportConfigResult =
  | {
      ok: true
      path: string
      channelCount: number
      keptLocalPaths: boolean
      parts: ConfigBundleParts
      channels: ChannelConfig[]
      groupOrder: string[]
      settings: AppSettings
      layout: UiLayoutState
    }
  | { ok: false; canceled: true }
  | { ok: false; error: string }

function stampFileName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `navora-monitor-config-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`
}

export function buildConfigBundle(parts: ConfigBundleParts = DEFAULT_CONFIG_PARTS): ConfigBundle {
  const fileChannels = channelStore.loadChannels()
  const groupOrder = channelStore.loadGroupOrder()
  const settings = loadSettings()
  const layout = layoutStore.loadLayout()
  return {
    kind: CONFIG_BUNDLE_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    channels: parts.channels ? fileChannels : [],
    groupOrder: parts.groupOrder ? groupOrder : [],
    // Paths / storage / host secrets stay on this machine — never write them out.
    settings: parts.settings ? stripMachineLocalSettings(settings) : { ...DEFAULT_SETTINGS },
    layout: parts.layout ? layout : defaultUiLayout(),
  }
}

export async function exportConfigToFile(
  win: BrowserWindow | null,
  rawParts?: Partial<ConfigBundleParts>,
): Promise<ExportConfigResult> {
  try {
    const parts = sanitizeConfigParts(rawParts)
    if (!parts.channels && !parts.groupOrder && !parts.settings && !parts.layout) {
      return { ok: false, error: '请至少选择一项要导出的内容' }
    }
    const bundle = buildConfigBundle(parts)
    const opts = {
      title: `导出配置（${describeConfigParts(parts)}）`,
      defaultPath: stampFileName(),
      filters: [{ name: 'Navora Monitor 配置', extensions: ['json'] }],
    }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    writeFileSync(res.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
    return {
      ok: true,
      path: res.filePath,
      channelCount: bundle.channels.length,
      parts,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function pickConfigImportFile(win: BrowserWindow | null): Promise<PickConfigImportResult> {
  try {
    const openOpts = {
      title: '选择要导入的配置文件',
      properties: ['openFile' as const],
      filters: [{ name: 'Navora Monitor 配置', extensions: ['json'] }],
    }
    const open = win
      ? await dialog.showOpenDialog(win, openOpts)
      : await dialog.showOpenDialog(openOpts)
    if (open.canceled || !open.filePaths[0]) return { ok: false, canceled: true }
    return inspectConfigImportFile(open.filePaths[0])
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Validate and summarize a config JSON at an absolute path (dialog pick or drag-drop). */
export function inspectConfigImportFile(filePath: string): PickConfigImportResult {
  try {
    const path = typeof filePath === 'string' ? filePath.trim() : ''
    if (!path) return { ok: false, error: '未指定配置文件' }
    if (!/\.json$/i.test(path)) {
      return { ok: false, error: '请选择 .json 配置文件' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return { ok: false, error: '无法解析 JSON 文件' }
    }

    const bundle = sanitizeConfigBundle(parsed)
    if (!bundle) {
      return {
        ok: false,
        error: '不是有效的 Navora Monitor 配置文件（缺少 kind）',
      }
    }

    return {
      ok: true,
      path,
      summary: configBundleSummary(bundle),
      exportedAt: bundle.exportedAt,
      available: configBundleAvailableParts(bundle),
      channelCount: bundle.channels.length,
      channels: bundle.channels.map((c) => ({
        id: c.id,
        name: c.name,
        group: channelGroup(c),
      })),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function applyConfigImport(
  win: BrowserWindow | null,
  args: {
    path: string
    parts?: Partial<ConfigBundleParts>
    /** @deprecated Ignored — machine-local paths/storage are always preserved. */
    keepLocalPaths?: boolean
    /** When importing channels, only these ids (from the file). Empty / omit = all. */
    channelIds?: string[]
  },
  opts: { recorders: RecorderManager; previews: PreviewManager },
): Promise<ImportConfigResult> {
  try {
    const parts = sanitizeConfigParts(args.parts)
    if (!parts.channels && !parts.groupOrder && !parts.settings && !parts.layout) {
      return { ok: false, error: '请至少选择一项要导入的内容' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(args.path, 'utf8'))
    } catch {
      return { ok: false, error: '无法解析 JSON 文件' }
    }

    const bundle = sanitizeConfigBundle(parsed)
    if (!bundle) {
      return { ok: false, error: '不是有效的 Navora Monitor 配置文件' }
    }

    const available = configBundleAvailableParts(bundle)
    const effective: ConfigBundleParts = {
      channels: parts.channels && available.channels,
      groupOrder: parts.groupOrder && (available.groupOrder || available.channels),
      settings: parts.settings,
      layout: parts.layout,
    }
    if (!effective.channels && !effective.groupOrder && !effective.settings && !effective.layout) {
      return { ok: false, error: '所选内容在文件中不可用' }
    }

    let importChannels = bundle.channels
    if (effective.channels) {
      if (Array.isArray(args.channelIds)) {
        const want = new Set(
          args.channelIds.filter((id): id is string => typeof id === 'string' && !!id.trim()),
        )
        importChannels = bundle.channels.filter((c) => want.has(c.id))
        if (!importChannels.length) {
          return { ok: false, error: '请至少选择一台要导入的设备' }
        }
      }
      if (!importChannels.length) {
        return { ok: false, error: '文件中没有可导入的设备' }
      }
    }

    opts.previews.stopAll()
    if (effective.channels) opts.recorders.stopAll()

    const keepLocalPaths = true
    const current = loadSettings()

    if (effective.channels) {
      let order = effective.groupOrder ? bundle.groupOrder : channelStore.loadGroupOrder()
      // Keep group order entries that still appear among imported channels
      const usedGroups = new Set(importChannels.map((c) => channelGroup(c)))
      order = order.filter((g) => usedGroups.has(g) || g === DEFAULT_GROUP)
      for (const g of usedGroups) {
        if (g !== DEFAULT_GROUP && !order.includes(g)) order.push(g)
      }
      channelStore.replaceChannelsFile(importChannels, order)
    } else if (effective.groupOrder) {
      channelStore.setGroupOrder(bundle.groupOrder)
    }

    let layout = layoutStore.loadLayout()
    if (effective.layout) {
      layout = layoutStore.saveLayout(bundle.layout)
    }

    let nextSettings = current
    if (effective.settings) {
      // Always keep this machine's paths, storage policy, and remote password.
      nextSettings = mergeSettingsKeepingLocalPaths(bundle.settings, current)
      const nest = findStorageNestConflict({
        recordingsPath: nextSettings.recordingsPath,
        savedClipsPath: nextSettings.savedClipsPath,
        snapshotsPath: nextSettings.snapshotsPath,
      })
      if (nest) {
        return { ok: false, error: `存储路径不安全：${nest}` }
      }
      nextSettings = replaceSettings(nextSettings)
    }

    ensureDir(recordingsRoot())
    ensureDir(snapshotsRoot())
    ensureDir(savedClipsRoot())
    opts.recorders.refreshFfmpeg()
    opts.previews.refreshFfmpeg()

    return {
      ok: true,
      path: args.path,
      channelCount: channelStore.loadChannels().length,
      keptLocalPaths: keepLocalPaths,
      parts: effective,
      channels: channelStore.loadChannels(),
      groupOrder: channelStore.loadGroupOrder(),
      settings: nextSettings,
      layout,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** @deprecated path — prefer pick + apply; kept for compatibility */
export async function importConfigFromFile(
  win: BrowserWindow | null,
  opts: { recorders: RecorderManager; previews: PreviewManager },
): Promise<ImportConfigResult> {
  const picked = await pickConfigImportFile(win)
  if (!picked.ok) return picked
  const boxOpts = {
    type: 'warning' as const,
    title: '导入配置',
    message: '确定导入配置？',
    detail:
      `${picked.summary}\n导出时间：${picked.exportedAt}\n\n` +
      '将按文件内容替换所选项目。本机路径与存储感知设置不会被覆盖。',
    buttons: ['取消', '导入'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  }
  const choice = win
    ? await dialog.showMessageBox(win, boxOpts)
    : await dialog.showMessageBox(boxOpts)
  if (choice.response === 0) return { ok: false, canceled: true }
  return applyConfigImport(
    win,
    {
      path: picked.path,
      parts: DEFAULT_CONFIG_PARTS,
    },
    opts,
  )
}
