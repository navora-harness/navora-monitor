import { describe, expect, it } from 'vitest'
import {
  CONFIG_BUNDLE_KIND,
  mergeSettingsKeepingLocalPaths,
  sanitizeConfigBundle,
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
      settings: { retentionDays: 7 },
      layout: { mosaic: 9 },
    })
    expect(bundle).not.toBeNull()
    expect(bundle!.channels.map((c) => c.id)).toEqual(['a', 'b'])
    expect(bundle!.groupOrder).toEqual(['一层', '二层'])
    expect(bundle!.settings.retentionDays).toBe(7)
    expect(bundle!.layout.mosaic).toBe(9)
  })

  it('keeps local path settings on merge', () => {
    const imported = {
      ...DEFAULT_SETTINGS,
      recordingsPath: 'D:\\imported\\rec',
      ffmpegPath: 'D:\\imported\\ffmpeg.exe',
      retentionDays: 14,
    }
    const current = {
      ...DEFAULT_SETTINGS,
      recordingsPath: 'E:\\local\\rec',
      ffmpegPath: 'C:\\ffmpeg\\ffmpeg.exe',
      retentionDays: 3,
    }
    const merged = mergeSettingsKeepingLocalPaths(imported, current)
    expect(merged.recordingsPath).toBe('E:\\local\\rec')
    expect(merged.ffmpegPath).toBe('C:\\ffmpeg\\ffmpeg.exe')
    expect(merged.retentionDays).toBe(14)
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
