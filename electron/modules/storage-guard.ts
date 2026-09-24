import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { statfs } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import type { DiskSpaceInfo, StorageAction } from '../../shared/ipc-types'
import {
  cleanupTargetFreeBytes,
  estimateRemainSec,
  estimateWriteBytesPerSec,
  evaluateStorageLevel,
  formatDurationLabel,
  formatGbLabel,
  mergeStorageLevel,
  retentionExceedsCapacity,
  retentionNeedBytes,
  type StorageLevel,
} from '../../shared/storage-policy'
import { isRecordCacheActive, recordCacheRoot, recordingsRoot } from './data-root'
import { loadSettings } from './settings-store'
import { deleteAllRecordingFiles, deleteOldestSegments, sumRecordingBytes } from './recording-usage'
import { sumSavedClipBytes } from './saved-clips'
import type { RecorderManager } from './recorder-manager'

function sumDirMediaBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const lower = name.toLowerCase()
      // Loop recording writes MPEG-TS (.ts); keep .mp4 for any legacy segments.
      if (!lower.endsWith('.ts') && !lower.endsWith('.mp4')) continue
      try {
        total += statSync(join(dir, name)).size
      } catch {
        /* ignore */
      }
    }
  } catch {
    return 0
  }
  return total
}

function measureActiveWriteRate(recorders: RecorderManager): number {
  const now = Date.now()
  const samples: Array<{ bytesWritten: number; elapsedSec: number }> = []
  for (const s of recorders.listActiveSessions()) {
    const started = Date.parse(s.startedAt)
    if (!Number.isFinite(started)) continue
    const elapsedSec = Math.max(0, (now - started) / 1000)
    samples.push({
      bytesWritten: sumDirMediaBytes(s.outputDir),
      elapsedSec,
    })
  }
  return estimateWriteBytesPerSec(samples)
}

async function measureRaw(): Promise<{
  path: string
  freeBytes: number
  totalBytes: number
} | null> {
  const path = recordingsRoot()
  try {
    const st = await statfs(path)
    const freeBytes = Number(st.bfree) * Number(st.bsize)
    const totalBytes = Number(st.blocks) * Number(st.bsize)
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null
    return { path, freeBytes, totalBytes }
  } catch {
    return null
  }
}

function buildInfo(
  raw: { path: string; freeBytes: number; totalBytes: number },
  recordingsBytes: number,
  savedClipsBytes: number,
  writeBytesPerSec: number,
  lastAction: StorageAction | null,
): DiskSpaceInfo {
  const s = loadSettings()
  const floorLevel = evaluateStorageLevel(raw.freeBytes, s.diskWarnFreeGb, s.diskStopFreeGb)
  const estimatedRemainSec = estimateRemainSec(raw.freeBytes, writeBytesPerSec)
  const need = retentionNeedBytes(writeBytesPerSec, s.retentionDays)
  const capacityWarn = retentionExceedsCapacity(need, raw.freeBytes)
  const level = mergeStorageLevel(floorLevel, capacityWarn)
  return {
    path: raw.path,
    freeBytes: raw.freeBytes,
    totalBytes: raw.totalBytes,
    freeRatio: raw.freeBytes / raw.totalBytes,
    recordingsBytes,
    savedClipsBytes,
    writeBytesPerSec,
    estimatedRemainSec,
    retentionNeedBytes: need,
    retentionDays: s.retentionDays,
    retentionFit: !capacityWarn,
    level,
    recordingBlocked: floorLevel === 'critical',
    warn: level === 'warn' || level === 'critical',
    stop: floorLevel === 'critical',
    autoCleanup: s.diskAutoCleanup !== false,
    lastAction,
  }
}

/**
 * Main-process storage guardian tied to recording:
 * monitor free space + write-rate capacity vs retentionDays →
 * optional oldest-first cleanup → stop / block when critical.
 */
export class StorageGuard {
  private recorders: RecorderManager
  private getWindow: () => BrowserWindow | null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastInfo: DiskSpaceInfo | null = null
  private lastAction: StorageAction | null = null
  private stopLatched = false
  private lastLevel: StorageLevel | null = null
  private capacityWarned = false

  constructor(opts: { recorders: RecorderManager; getWindow: () => BrowserWindow | null }) {
    this.recorders = opts.recorders
    this.getWindow = opts.getWindow
  }

  getSnapshot(): DiskSpaceInfo | null {
    return this.lastInfo
  }

  start(intervalMs = 15_000) {
    this.stopTimer()
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<DiskSpaceInfo | null> {
    const raw = await measureRaw()
    if (!raw) {
      this.lastInfo = null
      return null
    }

    const s = loadSettings()
    const writeBytesPerSec = measureActiveWriteRate(this.recorders)
    let recordingsBytes = sumRecordingBytes()
    const savedClipsBytes = sumSavedClipBytes()
    let info = buildInfo(raw, recordingsBytes, savedClipsBytes, writeBytesPerSec, this.lastAction)

    if (info.level !== 'ok' && s.diskAutoCleanup !== false) {
      const floorLevel = evaluateStorageLevel(raw.freeBytes, s.diskWarnFreeGb, s.diskStopFreeGb)
      // Only auto-delete on hard free-space floors, not on retention-capacity warn alone
      if (floorLevel !== 'ok') {
        const target = cleanupTargetFreeBytes(s.diskWarnFreeGb, s.diskStopFreeGb)
        if (target != null && raw.freeBytes < target) {
          const need = target - raw.freeBytes
          const { deleted, freedBytes } = deleteOldestSegments(need)
          if (deleted > 0) {
            this.lastAction = {
              type: 'cleanup',
              message: `空间不足，已清理最早 ${deleted} 个分段（约 ${formatGbLabel(freedBytes)}）`,
              deleted,
              freedBytes,
              at: Date.now(),
            }
            this.emitAction(this.lastAction)
            const raw2 = await measureRaw()
            if (raw2) {
              recordingsBytes = sumRecordingBytes()
              info = buildInfo(raw2, recordingsBytes, sumSavedClipBytes(), writeBytesPerSec, this.lastAction)
            }
          }
        }
      }
    }

    if (!info.retentionFit && writeBytesPerSec > 0 && s.retentionDays > 0) {
      if (!this.capacityWarned) {
        this.capacityWarned = true
        const remain =
          info.estimatedRemainSec != null ? formatDurationLabel(info.estimatedRemainSec) : '—'
        this.lastAction = {
          type: 'capacity',
          message: `按当前码流，保留 ${s.retentionDays} 天约需 ${formatGbLabel(info.retentionNeedBytes ?? 0)}，剩余仅 ${formatGbLabel(info.freeBytes)}（约可再录 ${remain}）`,
          at: Date.now(),
        }
        info = { ...info, lastAction: this.lastAction }
        this.emitAction(this.lastAction)
      }
    } else if (info.retentionFit) {
      this.capacityWarned = false
    }

    if (info.stop) {
      if (this.recorders.activeCount() > 0 && !this.stopLatched) {
        this.recorders.stopAll()
        this.stopLatched = true
        this.lastAction = {
          type: 'stop',
          message: `磁盘空间危急（剩余 ${formatGbLabel(info.freeBytes)}），已停止全部录像`,
          at: Date.now(),
        }
        info = { ...info, lastAction: this.lastAction, recordingBlocked: true }
        this.emitAction(this.lastAction)
      }
    } else {
      this.stopLatched = false
    }

    if (this.lastLevel !== info.level) {
      this.lastLevel = info.level
      this.emitSnapshot(info)
    }

    this.lastInfo = info
    return info
  }

  async ensureRecordAllowed(): Promise<
    { ok: true; info: DiskSpaceInfo | null } | { ok: false; error: string; info: DiskSpaceInfo | null }
  > {
    const info = await this.tick()
    if (!info) return { ok: true, info: null }
    if (info.recordingBlocked || info.stop) {
      const action: StorageAction = {
        type: 'block',
        message: `磁盘空间不足（剩余 ${formatGbLabel(info.freeBytes)}），无法开始录像`,
        at: Date.now(),
      }
      this.lastAction = action
      this.lastInfo = { ...info, lastAction: action, recordingBlocked: true }
      return { ok: false, error: action.message, info: this.lastInfo }
    }
    return { ok: true, info }
  }

  canStartFromCache(): boolean {
    if (!this.lastInfo) return true
    return !this.lastInfo.recordingBlocked
  }

  async forceCleanup(): Promise<DiskSpaceInfo | null> {
    const s = loadSettings()
    const raw = await measureRaw()
    if (!raw) return null
    const target = cleanupTargetFreeBytes(s.diskWarnFreeGb || 5, s.diskStopFreeGb)
    if (target == null) return this.tick()
    const need = Math.max(1024 * 1024 * 1024, target - raw.freeBytes)
    const { deleted, freedBytes } = deleteOldestSegments(need)
    if (deleted > 0) {
      this.lastAction = {
        type: 'cleanup',
        message: `手动清理 ${deleted} 个最早分段（约 ${formatGbLabel(freedBytes)}）`,
        deleted,
        freedBytes,
        at: Date.now(),
      }
      this.emitAction(this.lastAction)
    }
    return this.tick()
  }

  /**
   * Wipe all loop recordings (and write-cache segments). Never touches saved clips.
   * Files currently locked by FFmpeg may be skipped.
   */
  async clearAllLoopRecordings(): Promise<DiskSpaceInfo | null> {
    const a = deleteAllRecordingFiles(recordingsRoot())
    let deleted = a.deleted
    let freedBytes = a.freedBytes
    if (isRecordCacheActive()) {
      const b = deleteAllRecordingFiles(recordCacheRoot())
      deleted += b.deleted
      freedBytes += b.freedBytes
    }
    this.lastAction = {
      type: 'cleanup',
      message:
        deleted > 0
          ? `已清空循环录像 ${deleted} 个分段（约 ${formatGbLabel(freedBytes)}），已保存内容未动`
          : '循环录像目录已为空（或文件正被占用未能删除）',
      deleted,
      freedBytes,
      at: Date.now(),
    }
    this.emitAction(this.lastAction)
    return this.tick()
  }

  private emitAction(action: StorageAction) {
    this.getWindow()?.webContents.send('nm:storageAction', action)
  }

  private emitSnapshot(info: DiskSpaceInfo) {
    this.getWindow()?.webContents.send('nm:storageChanged', info)
  }
}
