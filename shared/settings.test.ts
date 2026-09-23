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
      defaultRtspTransport: 'udp',
    })
    expect(s.recordingsPath).toBe('D:/cams')
    expect(s.defaultSegmentTimeSec).toBe(300) // below min → default
    expect(s.retentionDays).toBe(7)
    expect(s.closeToTray).toBe(false)
    expect(s.showMainOnStartup).toBe(false)
    expect(s.defaultRtspTransport).toBe('udp')
  })
})
