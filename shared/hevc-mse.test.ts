import { describe, expect, it, vi, afterEach } from 'vitest'
import { isHevcMseError, browserSupportsHevcNative } from './hevc-mse'

afterEach(() => vi.unstubAllGlobals())
describe('native HEVC capability', () => {
  it('detects a browser that only supports a specific HEVC profile', () => {
    vi.stubGlobal('document', { createElement: () => ({canPlayType: (type: string) => type.includes('hvc1.1.1.L120.B0') ? 'probably' : ''}) })
    expect(browserSupportsHevcNative()).toBe(true)
  })
  it('rejects an unsupported native codec even when MSE exists', () => {
    vi.stubGlobal('document', { createElement: () => ({canPlayType: () => ''}) })
    vi.stubGlobal('window', { MediaSource: {isTypeSupported: () => true} })
    expect(browserSupportsHevcNative()).toBe(false)
  })
})

describe('isHevcMseError', () => {
  it('matches Edge MSE addSourceBuffer HEVC rejection', () => {
    expect(
      isHevcMseError(
        'MediaMSEError',
        "Failed to execute 'addSourceBuffer' on 'MediaSource': The type provided ('video/mp4;codecs=hvc1.1.1.L150.B0') is unsupported.",
      ),
    ).toBe(true)
  })

  it('ignores unrelated mpegts errors', () => {
    expect(isHevcMseError('NetworkError', 'failed to fetch')).toBe(false)
  })
})
