import { describe, expect, it } from 'vitest'
import { isHevcMseError } from './hevc-mse'

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
