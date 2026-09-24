import { describe, expect, it } from 'vitest'
import { parseMediaUrl } from '../electron/modules/media-protocol'

describe('parseMediaUrl', () => {
  it('parses navora:/// triple-slash form', () => {
    const p = parseMediaUrl('navora:///recordings/cam-1/%E4%BA%91%E5%8F%B0-20260924-073555.ts')
    expect(p).toEqual({
      kind: 'recordings',
      channelId: 'cam-1',
      fileName: '云台-20260924-073555.ts',
    })
  })

  it('parses Chromium-hoisted host form navora://recordings/...', () => {
    const p = parseMediaUrl('navora://recordings/cam-1/file.ts')
    expect(p).toEqual({
      kind: 'recordings',
      channelId: 'cam-1',
      fileName: 'file.ts',
    })
  })

  it('parses navora://localhost/... form', () => {
    const p = parseMediaUrl('navora://localhost/saved/ch/clip.mp4')
    expect(p).toEqual({
      kind: 'saved',
      channelId: 'ch',
      fileName: 'clip.mp4',
    })
  })

  it('parses http localhost recordings URL', () => {
    const p = parseMediaUrl('http://127.0.0.1:41234/recordings/cam-x/广角-001.mp4')
    expect(p).toEqual({
      kind: 'recordings',
      channelId: 'cam-x',
      fileName: '广角-001.mp4',
    })
  })

  it('returns null for garbage', () => {
    expect(parseMediaUrl('navora://localhost/other/x/y')).toBeNull()
    expect(parseMediaUrl('not-a-url')).toBeNull()
  })
})
