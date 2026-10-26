import type { DiskSpaceInfo } from '@shared/ipc-types'
import type { AppSettings } from '@shared/settings'
import { bytesToGb, formatDurationLabel, formatGbLabel, gbToBytes } from '@shared/storage-policy'

export function storageSummary(disk: DiskSpaceInfo | null, settings: AppSettings) {
  const d = disk
  if (!d || !(d.totalBytes > 0)) {
    return {
      ready: false,
      freePct: 0,
      loopPct: 0,
      savedPct: 0,
      otherPct: 0,
      freeLabel: '—',
      loopLabel: '—',
      savedLabel: '—',
      totalLabel: '—',
      usedLabel: '—',
      remainLabel: '—',
      needLabel: '—',
      needPct: 0,
      warnPos: 0,
      stopPos: 0,
      level: 'ok' as const,
      retentionFit: true,
      path: '',
      writeMbps: '—',
    }
  }
  const total = d.totalBytes
  const free = d.freeBytes
  const loop = d.recordingsBytes
  const saved = d.savedClipsBytes
  const usedKnown = loop + saved
  const other = Math.max(0, total - free - usedKnown)
  const pct = (n: number) => Math.max(0, Math.min(100, (n / total) * 100))
  const warnPos = settings.diskWarnFreeGb > 0 ? pct(gbToBytes(settings.diskWarnFreeGb)) : 0
  const stopPos = settings.diskStopFreeGb > 0 ? pct(gbToBytes(settings.diskStopFreeGb)) : 0
  const need = d.retentionNeedBytes ?? 0
  return {
    ready: true,
    freePct: pct(free),
    loopPct: pct(loop),
    savedPct: pct(saved),
    otherPct: pct(other),
    freeLabel: formatGbLabel(free),
    loopLabel: formatGbLabel(loop),
    savedLabel: formatGbLabel(saved),
    totalLabel: formatGbLabel(total),
    usedLabel: formatGbLabel(total - free),
    remainLabel: d.estimatedRemainSec != null ? formatDurationLabel(d.estimatedRemainSec) : '—',
    needLabel: need > 0 ? formatGbLabel(need) : '—',
    needPct: need > 0 ? Math.min(120, (need / Math.max(free, 1)) * 100) : 0,
    warnPos,
    stopPos,
    level: d.level,
    retentionFit: d.retentionFit,
    path: d.path,
    freeGb: bytesToGb(free).toFixed(1),
    writeMbps: d.writeBytesPerSec > 0 ? ((d.writeBytesPerSec * 8) / 1_000_000).toFixed(1) : '0',
  }
}
