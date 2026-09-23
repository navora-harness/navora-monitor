import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { channelCacheDir, channelRecordDir, isRecordCacheActive, recordCacheRoot } from './data-root'

type WatchEntry = {
  channelId: string
  cacheDir: string
  destDir: string
  /** Keep the newest mp4 in cache while recording (active segment). */
  holdNewest: boolean
  timer: ReturnType<typeof setInterval> | null
}

function listMp4(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.mp4'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

function moveFile(src: string, dest: string): boolean {
  try {
    renameSync(src, dest)
    return true
  } catch {
    try {
      copyFileSync(src, dest)
      unlinkSync(src)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Moves completed cache segments into the archive recordings directory.
 * While a channel is recording, the newest file is held (still being written).
 */
export class SegmentFlusher {
  private watches = new Map<string, WatchEntry>()
  private moved = 0
  private failed = 0

  getStats() {
    return { moved: this.moved, failed: this.failed, pendingChannels: this.watches.size }
  }

  pendingFileCount(): number {
    let n = 0
    for (const w of this.watches.values()) {
      const files = listMp4(w.cacheDir)
      n += w.holdNewest ? Math.max(0, files.length - 1) : files.length
    }
    // also count orphan cache files when not watching
    return n
  }

  startChannel(channelId: string) {
    if (!isRecordCacheActive()) return
    this.stopChannelTimer(channelId)
    const cacheDir = channelCacheDir(channelId)
    const destDir = channelRecordDir(channelId)
    const entry: WatchEntry = {
      channelId,
      cacheDir,
      destDir,
      holdNewest: true,
      timer: null,
    }
    entry.timer = setInterval(() => this.flushChannel(channelId), 2000)
    this.watches.set(channelId, entry)
    this.flushChannel(channelId)
  }

  /** Stop holding newest file, flush remaining, then unwatch. */
  async stopChannel(channelId: string): Promise<void> {
    const w = this.watches.get(channelId)
    if (!w) {
      if (isRecordCacheActive()) this.flushChannelOnce(channelId, false)
      return
    }
    w.holdNewest = false
    // brief wait so ffmpeg can close the last segment
    await new Promise((r) => setTimeout(r, 800))
    this.flushChannel(channelId)
    this.stopChannelTimer(channelId)
    this.watches.delete(channelId)
  }

  /** Flush all watched + any leftover cache dirs. */
  flushAll(holdNewest = false): { moved: number; failed: number } {
    const beforeM = this.moved
    const beforeF = this.failed
    for (const id of [...this.watches.keys()]) {
      const w = this.watches.get(id)!
      w.holdNewest = holdNewest
      this.flushChannel(id)
    }
    // orphans
    if (existsSync(recordCacheRoot())) {
      for (const name of readdirSync(recordCacheRoot(), { withFileTypes: true })) {
        if (!name.isDirectory()) continue
        if (this.watches.has(name.name)) continue
        this.flushChannelOnce(name.name, false)
      }
    }
    return { moved: this.moved - beforeM, failed: this.failed - beforeF }
  }

  private stopChannelTimer(channelId: string) {
    const w = this.watches.get(channelId)
    if (w?.timer) {
      clearInterval(w.timer)
      w.timer = null
    }
  }

  private flushChannel(channelId: string) {
    const w = this.watches.get(channelId)
    if (w) this.flushDir(w.cacheDir, w.destDir, w.holdNewest)
    else this.flushChannelOnce(channelId, false)
  }

  private flushChannelOnce(channelId: string, holdNewest: boolean) {
    this.flushDir(channelCacheDir(channelId), channelRecordDir(channelId), holdNewest)
  }

  private flushDir(cacheDir: string, destDir: string, holdNewest: boolean) {
    const files = listMp4(cacheDir)
    if (!files.length) return
    const skip = holdNewest ? files[files.length - 1] : null
    for (const name of files) {
      if (name === skip) continue
      const src = join(cacheDir, name)
      // skip tiny / empty partials
      try {
        const st = statSync(src)
        if (st.size < 64) continue
      } catch {
        continue
      }
      const dest = join(destDir, basename(name))
      if (existsSync(dest)) {
        // already archived — drop cache copy
        try {
          unlinkSync(src)
          this.moved += 1
        } catch {
          this.failed += 1
        }
        continue
      }
      if (moveFile(src, dest)) this.moved += 1
      else this.failed += 1
    }
  }
}

export const segmentFlusher = new SegmentFlusher()
