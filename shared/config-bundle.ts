import type { AppSettings } from './settings'
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings'
import { sanitizeUiLayout, type UiLayoutState } from './panel-sizes'
import type { ChannelConfig } from './types'
import { sanitizeSchedule } from './schedule'
import { storedGroupValue } from './groups'

export const CONFIG_BUNDLE_KIND = 'navora-monitor-config' as const

export type ConfigBundle = {
  kind: typeof CONFIG_BUNDLE_KIND
  version: 1
  exportedAt: string
  appVersion?: string
  channels: ChannelConfig[]
  groupOrder: string[]
  settings: AppSettings
  layout: UiLayoutState
}

/** Which sections to include when exporting / applying an import. */
export type ConfigBundleParts = {
  channels: boolean
  /** Group order list (usually with channels). */
  groupOrder: boolean
  settings: boolean
  layout: boolean
}

export const DEFAULT_CONFIG_PARTS: ConfigBundleParts = {
  channels: true,
  groupOrder: true,
  settings: true,
  layout: true,
}

export function sanitizeConfigParts(raw: unknown): ConfigBundleParts {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG_PARTS }
  const o = raw as Partial<ConfigBundleParts>
  return {
    channels: o.channels !== false,
    groupOrder: o.groupOrder !== false,
    settings: o.settings !== false,
    layout: o.layout !== false,
  }
}

/** Absolute path / machine-bound fields — never transfer across machines. */
export const MACHINE_LOCAL_SETTING_KEYS = [
  // Storage paths
  'recordingsPath',
  'snapshotsPath',
  'savedClipsPath',
  'recordCachePath',
  'ffmpegPath',
  // Storage policy (disk / retention / write-cache) — depends on local disk
  'retentionDays',
  'diskWarnFreeGb',
  'diskStopFreeGb',
  'diskAutoCleanup',
  'recordCacheEnabled',
  // Host-only
  'openAtLogin',
  'remotePassword',
] as const satisfies readonly (keyof AppSettings)[]

/** @deprecated alias — use MACHINE_LOCAL_SETTING_KEYS */
export const LOCAL_PATH_SETTING_KEYS = MACHINE_LOCAL_SETTING_KEYS

/** Replace machine-local fields with defaults (for export JSON). */
export function stripMachineLocalSettings(settings: AppSettings): AppSettings {
  const next: AppSettings = { ...settings }
  for (const key of MACHINE_LOCAL_SETTING_KEYS) {
    next[key] = DEFAULT_SETTINGS[key] as never
  }
  return sanitizeSettings(next)
}

export function sanitizeChannelConfig(raw: unknown): ChannelConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<ChannelConfig>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.url !== 'string' || !o.url.trim()) return null
  return {
    id: o.id.trim(),
    name: (typeof o.name === 'string' && o.name.trim()) || o.id.trim(),
    url: o.url.trim(),
    enabled: o.enabled !== false,
    rtspTransport: o.rtspTransport === 'udp' ? 'udp' : 'tcp',
    segmentTimeSec: typeof o.segmentTimeSec === 'number' ? o.segmentTimeSec : 300,
    previewUrl:
      typeof o.previewUrl === 'string' && o.previewUrl.trim() ? o.previewUrl.trim() : undefined,
    schedule: sanitizeSchedule(o.schedule),
    group: storedGroupValue(typeof o.group === 'string' ? o.group : undefined),
  }
}

export function sanitizeConfigBundle(raw: unknown): ConfigBundle | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind !== CONFIG_BUNDLE_KIND) return null
  if (o.version !== 1 && o.version != null) return null

  const channelsRaw = Array.isArray(o.channels) ? o.channels : []
  const seen = new Set<string>()
  const channels: ChannelConfig[] = []
  for (const item of channelsRaw) {
    const ch = sanitizeChannelConfig(item)
    if (!ch || seen.has(ch.id)) continue
    seen.add(ch.id)
    channels.push(ch)
  }

  const groupOrder = Array.isArray(o.groupOrder)
    ? o.groupOrder
        .filter((x): x is string => typeof x === 'string' && !!x.trim())
        .map((x) => x.trim())
    : []

  const settings = sanitizeSettings(
    o.settings && typeof o.settings === 'object' ? (o.settings as Partial<AppSettings>) : {},
  )
  const layout = sanitizeUiLayout(
    o.layout && typeof o.layout === 'object' ? (o.layout as Partial<UiLayoutState>) : {},
  )

  return {
    kind: CONFIG_BUNDLE_KIND,
    version: 1,
    exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : new Date().toISOString(),
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : undefined,
    channels,
    groupOrder,
    settings,
    layout,
  }
}

/** Keep this machine's paths / storage / password when applying an imported bundle. */
export function mergeSettingsKeepingLocalPaths(
  imported: AppSettings,
  current: AppSettings,
): AppSettings {
  const next: AppSettings = { ...imported }
  for (const key of MACHINE_LOCAL_SETTING_KEYS) {
    next[key] = current[key] as never
  }
  return sanitizeSettings(next)
}

export function configBundleAvailableParts(bundle: ConfigBundle): ConfigBundleParts {
  return {
    channels: bundle.channels.length > 0,
    groupOrder: bundle.groupOrder.length > 0,
    settings: true,
    layout: true,
  }
}

export function configBundleSummary(bundle: ConfigBundle): string {
  const groups = new Set(bundle.groupOrder)
  for (const ch of bundle.channels) {
    if (ch.group?.trim()) groups.add(ch.group.trim())
  }
  const bits: string[] = []
  bits.push(`${bundle.channels.length} 路通道`)
  bits.push(`${groups.size} 个分组`)
  bits.push(`宫格 ${bundle.layout.mosaic}`)
  return bits.join(' · ')
}

export function describeConfigParts(parts: ConfigBundleParts): string {
  const bits: string[] = []
  if (parts.channels) bits.push('设备列表')
  if (parts.groupOrder) bits.push('分组顺序')
  if (parts.settings) bits.push('应用设置')
  if (parts.layout) bits.push('界面布局')
  return bits.length ? bits.join('、') : '（未选择）'
}
