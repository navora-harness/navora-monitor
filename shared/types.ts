/** Channel / recording domain types */

export type ChannelId = string

export type ChannelSchedule = {
  enabled: boolean
  /** 0=Sun … 6=Sat */
  days: number[]
  /** "HH:mm" 24h */
  start: string
  /** "HH:mm" 24h */
  end: string
}

export type ChannelConfig = {
  id: ChannelId
  /** Display name (also used as FFmpeg metadata title) */
  name: string
  /** Full RTSP/RTMP URL including credentials if needed */
  url: string
  enabled: boolean
  /** Prefer TCP for RTSP (default true) */
  rtspTransport?: 'tcp' | 'udp'
  /** Segment length in seconds (default 300) */
  segmentTimeSec?: number
  /** Sub-stream URL for preview (optional; falls back to url) */
  previewUrl?: string
  /** Weekly plan recording */
  schedule?: ChannelSchedule
  /** Device tree group name (default: 未分组) */
  group?: string
}

export type ChannelsFile = {
  version: 1
  channels: ChannelConfig[]
  /** Custom display order of group names; missing groups append after */
  groupOrder?: string[]
}

export type RecordingStatus = 'idle' | 'recording' | 'error'
export type PreviewStatus = 'idle' | 'starting' | 'live' | 'error'

export type ChannelRuntimeState = {
  id: ChannelId
  recording: RecordingStatus
  pid: number | null
  lastError: string | null
  outputDir: string | null
  startedAt: string | null
  preview: PreviewStatus
  previewUrl: string | null
  previewError: string | null
}

export type RecordingSegment = {
  id: string
  channelId: ChannelId
  fileName: string
  /** Absolute path on disk */
  path: string
  /** http://127.0.0.1:<port>/recordings/... or /saved/... (raw file) */
  url: string
  /**
   * Browser-playable MPEG-TS remux URL for mpegts.js.
   * Prefer this over `url` in the playback UI.
   */
  playbackUrl?: string | null
  sizeBytes: number
  mtimeMs: number
  /** Wall-clock range from filename / index / ffprobe */
  startMs: number | null
  endMs: number | null
  /** True for Tesla-style SavedClips — never auto-cleaned */
  protected?: boolean
  /** When the clip was saved (ms); only for protected clips */
  savedAt?: number
}

export type ProbeResult =
  | { ok: true; latencyMs: number; summary: string }
  | { ok: false; error: string; latencyMs: number }

export type AppInfo = {
  name: string
  version: string
  license: string
  copyright: string
  homepage: string
  licenseNote: string
  dataRoot: string
  recordingsPath: string
  snapshotsPath: string
  savedClipsPath: string
  recordCachePath: string
  recordCacheActive: boolean
  ffmpegPath: string | null
  ffmpegOk: boolean
  mediaBaseUrl: string | null
  defaultSegmentTimeSec: number
  savedClipDurationSec: number
}

export type StartRecordResult =
  | { ok: true; state: ChannelRuntimeState }
  | { ok: false; error: string; state?: ChannelRuntimeState }

export type StopRecordResult =
  | { ok: true; state: ChannelRuntimeState }
  | { ok: false; error: string }

export type StartPreviewResult =
  | { ok: true; state: ChannelRuntimeState }
  | { ok: false; error: string; state?: ChannelRuntimeState }
