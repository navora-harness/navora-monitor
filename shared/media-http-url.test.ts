import { describe, expect, it } from 'vitest'
import { forceHttpMediaUrl, httpMediaOrigin } from './media-http-url'

describe('forceHttpMediaUrl', () => {
  it('leaves http URLs unchanged', () => {
    const u = 'http://127.0.0.1:9/recordings/c/a.ts'
    expect(forceHttpMediaUrl(u, null)).toBe(u)
  })

  it('rewrites navora://localhost to http origin', () => {
    const out = forceHttpMediaUrl(
      'navora://localhost/recordings/cam-1/%E5%B9%BF%E8%A7%92.ts',
      'http://127.0.0.1:19200/recordings/x/y.ts',
    )
    expect(out).toBe('http://127.0.0.1:19200/recordings/cam-1/%E5%B9%BF%E8%A7%92.ts')
  })

  it('rewrites Chromium-hoisted navora://recordings/…', () => {
    const out = forceHttpMediaUrl(
      'navora://recordings/cam-1/file.ts',
      'http://127.0.0.1:1/',
    )
    expect(out).toBe('http://127.0.0.1:1/recordings/cam-1/file.ts')
  })
})

describe('httpMediaOrigin', () => {
  it('returns origin for http', () => {
    expect(httpMediaOrigin('http://127.0.0.1:55/recordings/a/b.ts')).toBe('http://127.0.0.1:55')
  })
  it('returns null for navora', () => {
    expect(httpMediaOrigin('navora://localhost/recordings/a/b.ts')).toBeNull()
  })
})
