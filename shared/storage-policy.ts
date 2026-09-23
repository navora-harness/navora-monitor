/** Pure storage policy helpers (shared by main + tests) */

export type StorageLevel = 'ok' | 'warn' | 'critical'

const GB = 1024 * 1024 * 1024
const DAY_SEC = 24 * 60 * 60

export function bytesToGb(bytes: number): number {
  return bytes / GB
}

export function gbToBytes(gb: number): number {
  return gb * GB
}

export function evaluateStorageLevel(
  freeBytes: number,
  warnFreeGb: number,
  stopFreeGb: number,
): StorageLevel {
  const freeGb = bytesToGb(freeBytes)
  if (stopFreeGb > 0 && freeGb < stopFreeGb) return 'critical'
  if (warnFreeGb > 0 && freeGb < warnFreeGb) return 'warn'
  return 'ok'
}

/** Target free bytes after emergency cleanup (prefer warn threshold). */
export function cleanupTargetFreeBytes(warnFreeGb: number, stopFreeGb: number): number | null {
  if (warnFreeGb > 0) return gbToBytes(warnFreeGb)
  if (stopFreeGb > 0) return gbToBytes(stopFreeGb + 1)
  return null
}

export function formatGbLabel(bytes: number): string {
  return `${bytesToGb(bytes).toFixed(1)} GB`
}

/**
 * Aggregate write rate from active sessions.
 * Each session contributes bytesWritten / elapsedSec; total rate is the sum.
 */
export function estimateWriteBytesPerSec(
  sessions: Array<{ bytesWritten: number; elapsedSec: number }>,
  minElapsedSec = 15,
): number {
  let rate = 0
  for (const s of sessions) {
    if (s.bytesWritten <= 0) continue
    if (s.elapsedSec < minElapsedSec) continue
    rate += s.bytesWritten / s.elapsedSec
  }
  return Number.isFinite(rate) && rate > 0 ? rate : 0
}

/** How many seconds of recording the free space can hold at the current rate. */
export function estimateRemainSec(freeBytes: number, bytesPerSec: number): number | null {
  if (!(bytesPerSec > 0) || !(freeBytes > 0)) return null
  const sec = freeBytes / bytesPerSec
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

/** Bytes needed to keep continuous recording for `retentionDays` at current rate. */
export function retentionNeedBytes(bytesPerSec: number, retentionDays: number): number | null {
  if (!(bytesPerSec > 0) || !(retentionDays > 0)) return null
  const need = bytesPerSec * retentionDays * DAY_SEC
  return Number.isFinite(need) && need > 0 ? need : null
}

/**
 * True when preset retention window would consume more than remaining free space
 * at the observed write rate.
 */
export function retentionExceedsCapacity(
  needBytes: number | null,
  freeBytes: number,
): boolean {
  if (needBytes == null) return false
  return needBytes > freeBytes
}

/** Merge free-space level with capacity (retention) warning — never upgrades to critical. */
export function mergeStorageLevel(level: StorageLevel, capacityWarn: boolean): StorageLevel {
  if (level === 'critical') return 'critical'
  if (capacityWarn || level === 'warn') return 'warn'
  return 'ok'
}

export function formatDurationLabel(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`
  if (sec < DAY_SEC) {
    const h = sec / 3600
    return h >= 10 ? `${Math.round(h)} 小时` : `${h.toFixed(1)} 小时`
  }
  const d = sec / DAY_SEC
  return d >= 10 ? `${Math.round(d)} 天` : `${d.toFixed(1)} 天`
}
