import { describe, expect, it } from 'vitest'
import { buildRtspUrls, guessPresetId, encodeRtspUserInfo, collectLanScanPorts, guessPresetFromOpenPorts } from './camera-presets'

describe('camera-presets', () => {
  it('builds hikvision main/sub urls', () => {
    const built = buildRtspUrls({
      presetId: 'hikvision',
      host: '192.168.1.64',
      username: 'admin',
      password: 'pass',
      channel: 1,
    })
    expect(built?.url).toBe('rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/101')
    expect(built?.previewUrl).toBe('rtsp://admin:pass@192.168.1.64:554/Streaming/Channels/102')
  })

  it('builds dahua urls with subtype', () => {
    const built = buildRtspUrls({
      presetId: 'dahua',
      host: '10.0.0.8',
      channel: 2,
    })
    expect(built?.url).toContain('channel=2&subtype=0')
    expect(built?.previewUrl).toContain('subtype=1')
  })

  it('builds ezviz dual-lens urls', () => {
    const ch1 = buildRtspUrls({
      presetId: 'ezviz',
      host: '192.168.31.165',
      username: 'admin',
      password: 'CODE12',
      channel: 1,
    })
    expect(ch1?.url).toBe('rtsp://admin:CODE12@192.168.31.165:554/h264/ch1/main/av_stream')
    expect(ch1?.previewUrl).toBe('rtsp://admin:CODE12@192.168.31.165:554/h264/ch1/sub/av_stream')

    const ch2 = buildRtspUrls({
      presetId: 'ezviz',
      host: '192.168.31.165',
      username: 'admin',
      password: 'CODE12',
      channel: 2,
    })
    expect(ch2?.url).toBe('rtsp://admin:CODE12@192.168.31.165:554/h264/ch2/main/av_stream')
    expect(ch2?.previewUrl).toBe('rtsp://admin:CODE12@192.168.31.165:554/h264/ch2/sub/av_stream')
  })

  it('encodes special chars in password', () => {
    expect(encodeRtspUserInfo('admin', 'a@b')).toBe('admin:a%40b@')
  })

  it('guesses brand from manufacturer', () => {
    expect(guessPresetId('Hikvision')).toBe('hikvision')
    expect(guessPresetId('Dahua Technology')).toBe('dahua')
    expect(guessPresetId('EZVIZ')).toBe('ezviz')
    expect(guessPresetId('萤石')).toBe('ezviz')
  })

  it('collects vendor LAN scan ports', () => {
    const ports = collectLanScanPorts()
    expect(ports).toContain(554)
    expect(ports).toContain(8000)
    expect(ports).toContain(37777)
    expect(ports).not.toContain(80)
  })

  it('guesses preset from open ports', () => {
    expect(guessPresetFromOpenPorts([8000])).toBe('hikvision')
    expect(guessPresetFromOpenPorts([37777])).toBe('dahua')
    expect(guessPresetFromOpenPorts([554])).toBe('hikvision')
    expect(guessPresetFromOpenPorts([554, 8000])).toBe('hikvision')
    expect(guessPresetFromOpenPorts([80, 443])).toBeNull()
  })
})
