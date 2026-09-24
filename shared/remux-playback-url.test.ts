import { describe, expect, it } from 'vitest'
import { toRemuxPlaybackUrl, withRemuxStartSec } from './remux-playback-url'

describe('toRemuxPlaybackUrl', () => {
  it('rewrites recordings.ts to /remux path with t=', () => {
    const url = toRemuxPlaybackUrl(
      'http://127.0.0.1:19200/recordings/cam-1/%E5%B9%BF%E8%A7%92-20260924-134137.ts',
      12.5,
    )
    expect(url).toBeTruthy()
    const u = new URL(url!)
    expect(u.pathname).toBe('/remux/recordings/cam-1/%E5%B9%BF%E8%A7%92-20260924-134137.ts')
    expect(u.searchParams.get('t')).toBe('12.500')
  })

  it('rejects non-http and non-ts', () => {
    expect(toRemuxPlaybackUrl('navora://localhost/recordings/c/a.ts', 0)).toBeNull()
    expect(toRemuxPlaybackUrl('http://127.0.0.1:1/recordings/c/a.mp4', 0)).toBeNull()
  })
})

describe('withRemuxStartSec', () => {
  it('updates t query', () => {
    const a = toRemuxPlaybackUrl('http://127.0.0.1:9/recordings/c/x.ts', 1)!
    const b = withRemuxStartSec(a, 30)
    expect(new URL(b).searchParams.get('t')).toBe('30.000')
    expect(new URL(b).pathname).toContain('/remux/')
  })
})
