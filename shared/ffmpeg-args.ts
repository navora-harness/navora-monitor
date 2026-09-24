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
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    // Keep camera PTS when present; only drop corrupt packets.
    // (genpts alone does not unify A/V timelines — see finalizeSegmentTs.)
    '-fflags',
    '+discardcorrupt',
    '-probesize',
    '2000000',
    '-analyzeduration',
    '2000000',
  ]

  if (opts.inputUrl.toLowerCase().startsWith('rtsp://')) {
    args.push('-rtsp_transport', opts.rtspTransport ?? 'tcp')
  }

  args.push(
    '-i',
    opts.inputUrl,
    // Prefer explicit A/V maps — avoid data/metadata PIDs with odd timebases.
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    // Re-insert codec extradata before keyframes when the camera only sent
    // VPS/SPS/PPS once at stream open (common on H.264/H.265 RTSP).
    '-bsf:v',
    'dump_extra=freq=keyframe',
    // Segment muxer "reset" — not a guaranteed A/V rebase; normalize on finalize.
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'disabled',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-metadata',
    `title=${opts.title}`,
    '-f',
    'segment',
    '-segment_time',
    String(segmentTime),
    // Stay on keyframe boundaries when possible (copy still cannot invent IDRs).
    '-break_non_keyframes',
    '0',
    '-strftime',
    '1',
    // MPEG-TS remux; seek granularity follows camera GOP.
    // Prefer cameras with ≤2s keyint for accurate scrubbing.
    '-segment_format',
    'mpegts',
    // Re-emit PAT/PMT so each finished .ts is more self-describing for players.
    '-segment_format_options',
    'mpegts_flags=+resend_headers',
    opts.outputPattern,
  )

  return args
}

export type NormalizeTsRemuxOptions = {
  inputPath: string
  outputPath: string
  /** When false, video only. Default true (optional audio via 0:a:0?). */
  includeAudio?: boolean
}

/**
 * Stream-copy remux that rebases every mapped stream to PTS=0.
 * Fixes CCTV segments where audio was reset (~1.4s) but video kept PCR (30k–50k s).
 */
export function buildNormalizeTsRemuxArgs(opts: NormalizeTsRemuxOptions): string[] {
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    opts.inputPath,
    '-map',
    '0:v:0',
  ]
  if (opts.includeAudio !== false) {
    args.push('-map', '0:a:0?')
  }
  args.push(
    '-c',
    'copy',
    '-bsf:v',
    'setts=ts=PTS-STARTPTS',
  )
  if (opts.includeAudio !== false) {
    args.push('-bsf:a', 'setts=ts=PTS-STARTPTS')
  }
  args.push(
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-f',
    'mpegts',
    opts.outputPath,
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

export type Fmp4PlaybackRemuxOptions = {
  /** Absolute path to a finished .ts segment on disk */
  inputPath: string
  /** Seek into the file (seconds). Applied before -i for keyframe-aligned copy. */
  startSec?: number
}

/**
 * Stream-copy MPEG-TS → fragmented MP4 on stdout (pipe:1).
 * Note: Chromium &lt;video src&gt; cannot open progressive fMP4 (empty_moov);
 * prefer {@link buildFaststartPlaybackRemuxArgs} for native playback.
 */
export function buildFmp4PlaybackRemuxArgs(opts: Fmp4PlaybackRemuxOptions): string[] {
  const start = Math.max(0, opts.startSec ?? 0)
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts+igndts',
  ]
  if (start > 0.05) {
    args.push('-ss', start.toFixed(3))
  }
  args.push(
    '-i',
    opts.inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-tag:v',
    'hvc1',
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  )
  return args
}

export type FaststartPlaybackRemuxOptions = {
  inputPath: string
  outputPath: string
  startSec?: number
  /** When false, video only (CCTV TS often has no audio PID). Default true. */
  includeAudio?: boolean
}

/**
 * Stream-copy MPEG-TS → regular MP4 with moov at front (temp file).
 * Chromium native demuxer can play this; fragmented pipe cannot.
 */
export function buildFaststartPlaybackRemuxArgs(opts: FaststartPlaybackRemuxOptions): string[] {
  const start = Math.max(0, opts.startSec ?? 0)
  const args: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+genpts+igndts',
  ]
  if (start > 0.05) {
    args.push('-ss', start.toFixed(3))
  }
  args.push('-i', opts.inputPath, '-map', '0:v:0')
  if (opts.includeAudio !== false) {
    args.push('-map', '0:a:0')
  }
  args.push(
    '-c',
    'copy',
    '-tag:v',
    'hvc1',
    '-reset_timestamps',
    '1',
    '-avoid_negative_ts',
    'make_zero',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    opts.outputPath,
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
