import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings'

describe('sanitizeSettings', () => {
  it('applies defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid paths and clamps segment', () => {
    const s = sanitizeSettings({
      recordingsPath: ' D:/cams ',
      defaultSegmentTimeSec: 5,
      retentionDays: 7,
      closeToTray: false,
      showMainOnStartup: false,
      openAtLogin: true,
      defaultRtspTransport: 'udp',
    })
    expect(s.recordingsPath).toBe('D:/cams')
    expect(s.defaultSegmentTimeSec).toBe(300) // below min → default
    expect(s.retentionDays).toBe(7)
    expect(s.closeToTray).toBe(false)
    expect(s.showMainOnStartup).toBe(false)
    expect(s.openAtLogin).toBe(true)
    expect(s.defaultRtspTransport).toBe('udp')
  })

  it('defaults openAtLogin to false', () => {
    expect(sanitizeSettings({}).openAtLogin).toBe(false)
    expect(DEFAULT_SETTINGS.openAtLogin).toBe(false)
  })

  it('sanitizes remoteUsername', () => {
    expect(sanitizeSettings({ remoteUsername: ' ops ' }).remoteUsername).toBe('ops')
    expect(sanitizeSettings({ remoteUsername: '' }).remoteUsername).toBe('admin')
    expect(sanitizeSettings({ remoteUsername: 'bad name!' }).remoteUsername).toBe('admin')
    expect(sanitizeSettings({ remoteUsername: 'a'.repeat(33) }).remoteUsername).toBe('admin')
    expect(DEFAULT_SETTINGS.remoteUsername).toBe('admin')
  })
})
