import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingSegment } from '@shared/types'

const engine = vi.hoisted(() => ({
  load: vi.fn(async (_options: unknown) => {}), seek: vi.fn(async (_time: number) => {}),
  play: vi.fn(async () => true), cancel: vi.fn(), unload: vi.fn(),
  vodUnload: vi.fn(), session: false,
  events: {} as Record<string, (...args: any[]) => void>,
}))
vi.mock('./stream-engine', () => ({ StreamEngine: class {
  get hasSession() { return engine.session }; hasSource = true; relativeSec = 0; durationSec = 60
  on(name: string, fn: (...args: any[]) => void) { engine.events[name] = fn }
  attach() {} detach() {} setActive() {} setPlaybackRate() {} setVolume() {} pause() {}
  load = engine.load; seek = engine.seek; play = engine.play; unload = engine.unload; cancelPending = engine.cancel
} }))
vi.mock('./vod-engine', () => ({ VodEngine: class {
  on() {} attach() {} detach() {} setActive() {} setAuthToken() {} setPlaybackRate() {} setVolume() {} pause() {} unload = engine.vodUnload
} }))
import { PlaybackController } from './playback-controller'

const start = 1_790_000_000_000
function segment(id: string, offset = 0): RecordingSegment {
  return { id, channelId: 'cam', fileName: id + '.ts', path: id, url: '/media/files/recordings/cam/' + id + '.ts', sizeBytes: 1_000_000, mtimeMs: start, startMs: start + offset, endMs: start + offset + 60_000, state: 'ready' }
}
function response() { return { ok: true, json: async () => ({ ok: true, url: '/media/cache/prepared.mp4' }) } }

describe('playback operation lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks()
    engine.session = false
    vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:' })
    vi.stubGlobal('fetch', vi.fn(async () => response()))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  function setup() {
    const controller = new PlaybackController()
    controller.attach({} as HTMLVideoElement)
    controller.setChannelContext({ channelId: 'cam' })
    controller.setSegments([segment('a'), segment('b', 60_000)])
    return controller
  }
  it('loads a prepared HTTP URL directly, without downloading the media as a blob', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'), 10)
    expect(engine.load).toHaveBeenCalledWith(expect.objectContaining({ transport: 'native', startOffsetSec: 10, url: 'http://localhost/media/cache/prepared.mp4' }))
    controller.detach()
  })
  it('plays the exact selected saved clip when two clips overlap', async () => {
    const controller = setup()
    const a = {...segment('saved-a'), fileName:'saved-a.mp4', url:'/media/files/saved/cam/saved-a.mp4', protected:true}
    const b = {...segment('saved-b', 2000), fileName:'saved-b.mp4', url:'/media/files/saved/cam/saved-b.mp4', protected:true}
    controller.setChannelContext({channelId:'cam', source:'saved'})
    controller.setSegments([a,b])
    await controller.playSegment(a, 3)
    engine.events.time(3)
    expect(controller.getCurrentSegment()?.id).toBe('saved-a')
    await controller.playSegment(b, 1)
    expect(controller.getCurrentSegment()?.id).toBe('saved-b')
    expect(engine.load).toHaveBeenLastCalledWith(expect.objectContaining({url:'/media/files/saved/cam/saved-b.mp4',startOffsetSec:1}))
    controller.detach()
  })
  it('keeps the native video source when seeking within the same file', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'))
    engine.session = true
    engine.vodUnload.mockClear()
    await controller.playSegment(segment('a'), 10)
    expect(engine.seek).toHaveBeenCalledWith(10)
    expect(engine.vodUnload).not.toHaveBeenCalled()
    expect(engine.load).toHaveBeenCalledOnce()
    controller.detach()
  })
  it('advances to the next overlapping saved file without replaying the first', async () => {
    const controller = setup()
    const a = {...segment('saved-a'), fileName:'saved-a.mp4', url:'/media/files/saved/cam/saved-a.mp4', protected:true}
    const b = {...segment('saved-b', 2000), fileName:'saved-b.mp4', url:'/media/files/saved/cam/saved-b.mp4', protected:true}
    controller.setChannelContext({channelId:'cam', source:'saved'})
    controller.setSegments([a,b])
    await controller.playSegment(a)
    engine.events.ended()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.getCurrentSegment()?.id).toBe('saved-b')
    expect(engine.load).toHaveBeenLastCalledWith(expect.objectContaining({url:'/media/files/saved/cam/saved-b.mp4',startOffsetSec:0}))
    controller.detach()
  })
  it('aborts an obsolete preparation and plays the latest scrub target', async () => {
    const controller = setup()
    let signal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      signal = options?.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const old = controller.playSegment(segment('a'), 10)
    controller.scrubToWall(start + 70_000)
    await vi.advanceTimersByTimeAsync(200)
    await old
    expect(signal?.aborted).toBe(true)
    expect(engine.load).toHaveBeenCalledTimes(1)
    expect(engine.load).toHaveBeenCalledWith(expect.objectContaining({ startOffsetSec: 10 }))
    expect(controller.getCurrentSegment()?.id).toBe('b')
    controller.detach()
  })
  it('unloads the previous video before waiting for another recording to prepare', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'))
    engine.unload.mockClear()
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const next = controller.playSegment(segment('b', 60_000))
    expect(engine.unload).toHaveBeenCalledOnce()
    expect(controller.playUrl).toBeNull()
    expect(engine.load).toHaveBeenCalledTimes(1)
    finish(response() as Response)
    await next
    expect(engine.load).toHaveBeenCalledTimes(2)
    controller.detach()
  })
  it('does not advance to the next recording when continuous playback is off', async () => {
    const controller = setup()
    controller.setContinuous(false)
    await controller.playSegment(segment('a'))
    engine.events.ended()
    await vi.advanceTimersByTimeAsync(200)
    expect(engine.load).toHaveBeenCalledTimes(1)
    controller.detach()
  })
  it('reuses the versioned next-segment preparation on automatic advance', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'))
    engine.events.time(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    engine.events.ended()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.getCurrentSegment()?.id).toBe('b')
    expect(fetch).toHaveBeenCalledTimes(2)
    controller.detach()
  })
  it('retries failed background preparation after a bounded delay', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'))
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ ok:false }) } as Response)
    engine.events.time(50)
    await vi.advanceTimersByTimeAsync(0)
    engine.events.time(51)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    engine.events.time(56)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)
    controller.detach()
  })
  it('marks speculative preparation as background work and cancels it when continuous playback is disabled', async () => {
    const controller=setup()
    await controller.playSegment(segment('a'))
    let signal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
      signal=options?.signal as AbortSignal
      expect(JSON.parse(String(options?.body)).prefetch).toBe(true)
      signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))
    }))
    engine.events.time(50)
    expect(signal).toBeDefined()
    controller.setContinuous(false)
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    controller.detach()
  })
  it('prepares the next segment earlier at high playback speeds', async () => {
    const controller=setup()
    await controller.playSegment(segment('a'))
    controller.setRate(4)
    engine.events.time(10)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
    controller.detach()
  })
  it('clears media and cancels pending work when switching channels', async () => {
    const controller = setup()
    await controller.playSegment(segment('a'))
    controller.setChannelContext({ channelId: 'other' })
    expect(controller.getCurrentSegment()).toBeNull()
    expect(engine.cancel).toHaveBeenCalled()
    controller.detach()
  })
})
