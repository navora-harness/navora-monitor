/**
 * FFmpeg argv builders for recording / preview / probe.
 */

export type SegmentRecordOptions = {
  inputUrl: string
  outputPattern: string
  title: string
  segmentTimeSec?: number
  rtspTransport?: 'tcp' | 'udp'
}

export type MpegtsPreviewOptions = {
  inputUrl: string
  rtspTransport?: 'tcp' | 'udp'
}

export type ProbeOptions = {
  inputUrl: string
  rtspTransport?: 'tcp' | 'udp'
  /** Analyze seconds (ffmpeg -t) */
  durationSec?: number
}

export function buildSegmentRecordArgs(opts: SegmentRecordOptions): string[] {
  const segmentTime = Math.max(10, Math.round(opts.segmentTimeSec ?? 300))
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-y']

  if (opts.inputUrl.toLowerCase().startsWith('rtsp://')) {
    args.push('-rtsp_transport', opts.rtspTransport ?? 'tcp')
  }

  args.push(
    '-i',
    opts.inputUrl,
    '-c',
    'copy',
    '-reset_timestamps',
    '1',
    '-metadata',
    `title=${opts.title}`,
    '-map',
    '0',
    '-f',
    'segment',
    '-segment_time',
    String(segmentTime),
    '-segment_format',
    'mp4',
    opts.outputPattern,
  )

  return args
}

/**
 * Low-latency MPEG-TS remux to stdout (pipe:1).
 * Browser plays via mpegts.js — typically ~0.5–1.5s vs multi-second HLS.
 *
 * Notes:
 * - Do NOT use tiny probesize (e.g. 32): RTSP often fails to open.
 * - Do NOT force h264_mp4toannexb: breaks HEVC / already-annexB streams;
 *   mpegts muxer applies needed bitstream filters itself.
 */
export function buildMpegtsPreviewArgs(opts: MpegtsPreviewOptions): string[] {
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-fflags',
    'nobuffer+genpts+discardcorrupt',
    '-flags',
    'low_delay',
    '-probesize',
    '1000000',
    '-analyzeduration',
    '1000000',
  ]

  if (opts.inputUrl.toLowerCase().startsWith('rtsp://')) {
    args.push('-rtsp_transport', opts.rtspTransport ?? 'tcp')
  }

  args.push(
    '-i',
    opts.inputUrl,
    '-an',
    '-c:v',
    'copy',
    '-f',
    'mpegts',
    '-mpegts_flags',
    '+resend_headers',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-flush_packets',
    '1',
    'pipe:1',
  )

  return args
}

/** @deprecated kept for tests / fallback docs — prefer buildMpegtsPreviewArgs */
export function buildHlsPreviewArgs(opts: {
  inputUrl: string
  indexPath: string
  segmentPattern: string
  rtspTransport?: 'tcp' | 'udp'
  hlsTime?: number
  hlsListSize?: number
}): string[] {
  const hlsTime = Math.max(1, Math.round(opts.hlsTime ?? 1))
  const listSize = Math.max(2, Math.round(opts.hlsListSize ?? 4))
  const args: string[] = ['-hide_banner', '-loglevel', 'warning', '-y']
  if (opts.inputUrl.toLowerCase().startsWith('rtsp://')) {
    args.push('-rtsp_transport', opts.rtspTransport ?? 'tcp')
  }
  args.push(
    '-i',
    opts.inputUrl,
    '-an',
    '-c:v',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    String(hlsTime),
    '-hls_list_size',
    String(listSize),
    '-hls_flags',
    'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename',
    opts.segmentPattern,
    opts.indexPath,
  )
  return args
}

/** Short open to verify the stream is reachable. */
export function buildProbeArgs(opts: ProbeOptions): string[] {
  const duration = Math.max(1, Math.round(opts.durationSec ?? 3))
  const args: string[] = ['-hide_banner', '-loglevel', 'error']

  if (opts.inputUrl.toLowerCase().startsWith('rtsp://')) {
    args.push('-rtsp_transport', opts.rtspTransport ?? 'tcp')
  }

  args.push('-i', opts.inputUrl, '-t', String(duration), '-f', 'null', '-')
  return args
}

/** Safe filename stem from channel name/id */
export function sanitizeFileStem(raw: string): string {
  const s = raw
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+|\.+$/g, '')
  return s.slice(0, 64) || 'channel'
}
