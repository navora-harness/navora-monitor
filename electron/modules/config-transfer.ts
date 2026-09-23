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
  type ConfigBundle,
  type ConfigBundleParts,
  DEFAULT_CONFIG_PARTS,
} from '../../shared/config-bundle'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import type { ChannelConfig } from '../../shared/types'
import { defaultUiLayout, type UiLayoutState } from '../../shared/panel-sizes'
import * as channelStore from './channel-store'
import * as layoutStore from './layout-store'
import { loadSettings, replaceSettings } from './settings-store'
import { ensureDir, recordingsRoot, savedClipsRoot, snapshotsRoot } from './data-root'
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
    settings: parts.settings ? settings : { ...DEFAULT_SETTINGS },
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
    const path = open.filePaths[0]

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
    keepLocalPaths?: boolean
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

    opts.previews.stopAll()
    if (effective.channels) opts.recorders.stopAll()

    const keepLocalPaths = args.keepLocalPaths !== false
    const current = loadSettings()

    if (effective.channels) {
      const order = effective.groupOrder ? bundle.groupOrder : channelStore.loadGroupOrder()
      channelStore.replaceChannelsFile(bundle.channels, order)
    } else if (effective.groupOrder) {
      channelStore.setGroupOrder(bundle.groupOrder)
    }

    let layout = layoutStore.loadLayout()
    if (effective.layout) {
      layout = layoutStore.saveLayout(bundle.layout)
    }

    let nextSettings = current
    if (effective.settings) {
      nextSettings = replaceSettings(
        keepLocalPaths
          ? mergeSettingsKeepingLocalPaths(bundle.settings, current)
          : bundle.settings,
      )
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
      '将按文件内容替换所选项目。建议保留本机路径。',
    buttons: ['取消', '导入并保留本机路径', '全部导入'],
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
      keepLocalPaths: choice.response === 1,
    },
    opts,
  )
}
