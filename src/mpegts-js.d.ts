declare module 'mpegts.js' {
  export type Player = {
    attachMediaElement: (el: HTMLMediaElement) => void
    detachMediaElement: () => void
    load: () => void
    unload: () => void
    play: () => Promise<void>
    pause: () => void
    destroy: () => void
    on: (event: string, listener: (...args: unknown[]) => void) => void
  }

  export type MediaDataSource = {
    type: string
    isLive?: boolean
    url: string
    cors?: boolean
    hasAudio?: boolean
    hasVideo?: boolean
  }

  export type Config = Record<string, unknown>

  const mpegts: {
    createPlayer: (mediaDataSource: MediaDataSource, config?: Config) => Player
    getFeatureList: () => { mseLivePlayback: boolean }
    Events: { ERROR: string }
    isSupported: () => boolean
  }

  export default mpegts
}
