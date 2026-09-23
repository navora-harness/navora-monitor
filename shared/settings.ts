/** Application settings (persisted as settings.json under config root) */

export type AppSettings = {
  version: 1
  /**
   * Absolute directory for video recordings.
   * Empty string → `<configRoot>/recordings`
   */
  recordingsPath: string
  /**
   * Absolute directory for snapshots.
   * Empty string → `<configRoot>/snapshots`
   */
  snapshotsPath: string
  /** Default FFmpeg segment length when channel has no override */
  defaultSegmentTimeSec: number
  /** Default RTSP transport for new channels */
  defaultRtspTransport: 'tcp' | 'udp'
  /** Hide to tray on window close */
  closeToTray: boolean
  /** Show main window when the app starts (false → tray only until opened) */
  showMainOnStartup: boolean
  /** Optional absolute path to ffmpeg.exe; empty → PATH / env */
  ffmpegPath: string
  /**
   * Planned max storage window in days (0 = disabled).
   * Used for: (1) age-based retention cleanup; (2) capacity prediction —
   * if current write rate × retentionDays exceeds free space, warn.
   */
  retentionDays: number
  /**
   * Warn when free space on recordings volume is below this many GB.
   * 0 = disabled. Hard floor independent of write-rate prediction.
   */
  diskWarnFreeGb: number
  /**
   * Stop / block recording when free space is below this many GB.
   * 0 = disabled.
   */
  diskStopFreeGb: number
  /**
   * When space is below warn/stop, automatically delete oldest segments
   * until free space recovers to the warn threshold (before stopping).
   */
  diskAutoCleanup: boolean
  /**
   * Write new segments to a local cache first, then move to recordingsPath.
   * Helps when the archive disk (NAS / USB HDD) is slow.
   */
  recordCacheEnabled: boolean
  /**
   * Absolute directory for the write cache.
   * Empty string → `<configRoot>/record-cache`
   * Ignored (direct write) when resolved path equals recordings root.
   */
  recordCachePath: string
  /**
   * Absolute directory for user-saved (protected) clips.
   * Empty string → `<configRoot>/saved`
   * Never auto-deleted by retention / emergency cleanup.
   */
  savedClipsPath: string
  /**
   * When user taps “保存片段”, copy this many seconds of recent recording
   * (look-back from now). Tesla-style SavedClips. Default 600 (10 min).
   */
  savedClipDurationSec: number
  /** UI appearance: light / dark / follow OS */
  uiTheme: 'light' | 'dark' | 'system'
  /** Allow LAN browser remote monitoring */
  remoteEnabled: boolean
  /** HTTP listen port for remote UI + API */
  remotePort: number
  /** Password for fixed user `admin` (empty → auto-generate when enabling) */
  remotePassword: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  recordingsPath: '',
  snapshotsPath: '',
  defaultSegmentTimeSec: 300,
  defaultRtspTransport: 'tcp',
  closeToTray: true,
  showMainOnStartup: true,
  ffmpegPath: '',
  retentionDays: 0,
  diskWarnFreeGb: 5,
  diskStopFreeGb: 1,
  diskAutoCleanup: true,
  recordCacheEnabled: true,
  recordCachePath: '',
  savedClipsPath: '',
  savedClipDurationSec: 600,
  uiTheme: 'system',
  remoteEnabled: false,
  remotePort: 8780,
  remotePassword: '',
}

export function sanitizeSettings(raw: Partial<AppSettings> | null | undefined): AppSettings {
  const base = { ...DEFAULT_SETTINGS }
  if (!raw || typeof raw !== 'object') return base
  const seg = Number(raw.defaultSegmentTimeSec)
  const retention = Number(raw.retentionDays)
  const warnGb = Number(raw.diskWarnFreeGb)
  const stopGb = Number(raw.diskStopFreeGb)
  const savedDur = Number(raw.savedClipDurationSec)
  const remotePort = Number(raw.remotePort)
  const uiTheme =
    raw.uiTheme === 'dark' || raw.uiTheme === 'system' || raw.uiTheme === 'light'
      ? raw.uiTheme
      : base.uiTheme
  return {
    version: 1,
    recordingsPath: typeof raw.recordingsPath === 'string' ? raw.recordingsPath.trim() : '',
    snapshotsPath: typeof raw.snapshotsPath === 'string' ? raw.snapshotsPath.trim() : '',
    defaultSegmentTimeSec: Number.isFinite(seg) && seg >= 10 ? Math.round(seg) : base.defaultSegmentTimeSec,
    defaultRtspTransport: raw.defaultRtspTransport === 'udp' ? 'udp' : 'tcp',
    closeToTray: raw.closeToTray !== false,
    showMainOnStartup: raw.showMainOnStartup !== false,
    ffmpegPath: typeof raw.ffmpegPath === 'string' ? raw.ffmpegPath.trim() : '',
    retentionDays: Number.isFinite(retention) && retention >= 0 ? Math.round(retention) : 0,
    diskWarnFreeGb: Number.isFinite(warnGb) && warnGb >= 0 ? Math.round(warnGb * 10) / 10 : base.diskWarnFreeGb,
    diskStopFreeGb: Number.isFinite(stopGb) && stopGb >= 0 ? Math.round(stopGb * 10) / 10 : base.diskStopFreeGb,
    diskAutoCleanup: raw.diskAutoCleanup !== false,
    recordCacheEnabled: raw.recordCacheEnabled !== false,
    recordCachePath: typeof raw.recordCachePath === 'string' ? raw.recordCachePath.trim() : '',
    savedClipsPath: typeof raw.savedClipsPath === 'string' ? raw.savedClipsPath.trim() : '',
    savedClipDurationSec:
      Number.isFinite(savedDur) && savedDur >= 30
        ? Math.min(3600, Math.round(savedDur))
        : base.savedClipDurationSec,
    uiTheme,
    remoteEnabled: raw.remoteEnabled === true,
    remotePort:
      Number.isFinite(remotePort) && remotePort >= 1024 && remotePort <= 65535
        ? Math.round(remotePort)
        : base.remotePort,
    remotePassword: typeof raw.remotePassword === 'string' ? raw.remotePassword : base.remotePassword,
  }
}
