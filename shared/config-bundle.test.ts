import { describe, expect, it } from 'vitest'
import {
  CONFIG_BUNDLE_KIND,
  mergeSettingsKeepingLocalPaths,
  sanitizeConfigBundle,
  stripMachineLocalSettings,
} from './config-bundle'
import { DEFAULT_SETTINGS } from './settings'
import { defaultUiLayout } from './panel-sizes'

describe('config-bundle', () => {
  it('rejects unknown kind', () => {
    expect(sanitizeConfigBundle({ kind: 'other', channels: [] })).toBeNull()
  })

  it('sanitizes channels and drops duplicates', () => {
    const bundle = sanitizeConfigBundle({
      kind: CONFIG_BUNDLE_KIND,
      version: 1,
      channels: [
        { id: 'a', name: 'Cam A', url: 'rtsp://x' },
        { id: 'a', name: 'Dup', url: 'rtsp://y' },
        { id: '', url: 'rtsp://z' },
        { id: 'b', url: 'rtsp://b' },
      ],
      groupOrder: ['一层', '', '二层'],
      settings: { defaultSegmentTimeSec: 120, uiTheme: 'dark' },
      layout: { mosaic: 9 },
    })
    expect(bundle).not.toBeNull()
    expect(bundle!.channels.map((c) => c.id)).toEqual(['a', 'b'])
    expect(bundle!.groupOrder).toEqual(['一层', '二层'])
    expect(bundle!.settings.defaultSegmentTimeSec).toBe(120)
    expect(bundle!.settings.uiTheme).toBe('dark')
    expect(bundle!.layout.mosaic).toBe(9)
  })

  it('strips machine-local fields for export', () => {
    const stripped = stripMachineLocalSettings({
      ...DEFAULT_SETTINGS,
      recordingsPath: 'D:\\cams',
      retentionDays: 14,
      diskWarnFreeGb: 20,
      remotePassword: 'secret',
      openAtLogin: true,
      uiTheme: 'dark',
      defaultSegmentTimeSec: 180,
    })
    expect(stripped.recordingsPath).toBe('')
    expect(stripped.retentionDays).toBe(0)
    expect(stripped.diskWarnFreeGb).toBe(DEFAULT_SETTINGS.diskWarnFreeGb)
    expect(stripped.remotePassword).toBe('')
    expect(stripped.openAtLogin).toBe(false)
    expect(stripped.uiTheme).toBe('dark')
    expect(stripped.defaultSegmentTimeSec).toBe(180)
  })

  it('keeps machine-local settings on merge', () => {
    const imported = {
      ...DEFAULT_SETTINGS,
      recordingsPath: 'D:\\imported\\rec',
      ffmpegPath: 'D:\\imported\\ffmpeg.exe',
      retentionDays: 14,
      diskAutoCleanup: false,
      uiTheme: 'dark' as const,
    }
    const current = {
      ...DEFAULT_SETTINGS,
      recordingsPath: 'E:\\local\\rec',
      ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
      retentionDays: 3,
      diskAutoCleanup: true,
      uiTheme: 'light' as const,
    }
    const merged = mergeSettingsKeepingLocalPaths(imported, current)
    expect(merged.recordingsPath).toBe('E:\\local\\rec')
    expect(merged.ffmpegPath).toBe('C:\\ffmpeg\\ffmpeg.exe')
    expect(merged.retentionDays).toBe(3)
    expect(merged.diskAutoCleanup).toBe(true)
    expect(merged.uiTheme).toBe('dark')
  })

  it('accepts settings-only shape without channels key', () => {
    const bundle = sanitizeConfigBundle({
      kind: CONFIG_BUNDLE_KIND,
      settings: DEFAULT_SETTINGS,
      layout: defaultUiLayout(),
    })
    expect(bundle?.channels).toEqual([])
  })

  it('describes parts', async () => {
    const { describeConfigParts } = await import('./config-bundle')
    expect(describeConfigParts({ channels: true, groupOrder: false, settings: true, layout: false })).toContain(
      '设备列表',
    )
  })
})
