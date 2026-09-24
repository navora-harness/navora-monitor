import type { ChannelConfig } from '../../shared/types'
import { isScheduleActive } from '../../shared/schedule'
import type { RecorderManager } from './recorder-manager'
import type { StorageGuard } from './storage-guard'

/**
 * Tick schedule every N ms and start/stop recordings accordingly.
 * Respects StorageGuard: will not start when disk is critical.
 */
export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private scheduledIds = new Set<string>()
  private recorders: RecorderManager
  private loadChannels: () => ChannelConfig[]
  private storage: StorageGuard | null

  constructor(opts: {
    recorders: RecorderManager
    loadChannels: () => ChannelConfig[]
    storage?: StorageGuard | null
  }) {
    this.recorders = opts.recorders
    this.loadChannels = opts.loadChannels
    this.storage = opts.storage ?? null
  }

  setStorage(storage: StorageGuard | null) {
    this.storage = storage
  }

  start(intervalMs = 15_000) {
    this.stop()
    this.tick()
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = new Date()) {
    const channels = this.loadChannels()
    const canStart = this.storage?.canStartFromCache() !== false
    for (const ch of channels) {
      const want = ch.enabled && isScheduleActive(ch.schedule, now)
      const state = this.recorders.getState(ch.id)
      const recording = state.recording === 'recording'

      if (want && !recording) {
        if (!canStart) continue
        this.recorders.start(ch, { remember: false })
        this.scheduledIds.add(ch.id)
      } else if (!want && recording && this.scheduledIds.has(ch.id)) {
        this.recorders.stop(ch.id, { forget: false })
        this.scheduledIds.delete(ch.id)
      } else if (!want) {
        this.scheduledIds.delete(ch.id)
      }
    }
  }
}
