import { describe, expect, it } from 'vitest'
import {
  buildMpegtsPreviewArgs,
  buildProbeArgs,
  buildSegmentRecordArgs,
  buildNormalizeTsRemuxArgs,
  buildFmp4PlaybackRemuxArgs,
  buildFaststartPlaybackRemuxArgs,
  sanitizeFileStem,
} from './ffmpeg-args'

describe('buildSegmentRecordArgs', () => {
  it('matches remux + strftime segment pattern', () => {
    const args = buildSegmentRecordArgs({
      inputUrl: 'rtsp://user:pass@192.168.1.10:554/stream',
      outputPattern: 'rec-%Y%m%d-%H%M%S.ts',
      title: 'Cafe East',
      segmentTimeSec: 300,
    })
    expect(args).toContain('-rtsp_transport')
    expect(args).toContain('tcp')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).toContain('-map')
    expect(args).toContain('0:v:0')
    expect(args).toContain('0:a:0?')
    expect(args).toContain('-reset_timestamps')
    expect(args).toContain('-f')
    expect(args).toContain('segment')
    expect(args).toContain('-segment_time')
    expect(args).toContain('300')
    expect(args).toContain('-strftime')
    expect(args).toContain('1')
    expect(args).toContain('-segment_format')
    expect(args).toContain('mpegts')
    expect(args).toContain('+discardcorrupt')
    expect(args).not.toContain('+genpts+discardcorrupt')
    expect(args).toContain('dump_extra=freq=keyframe')
    expect(args).toContain('mpegts_flags=+resend_headers')
    expect(args).toContain('-avoid_negative_ts')
    expect(args).toContain('disabled')
    expect(args).toContain('-muxdelay')
    expect(args).toContain('-muxpreload')
    expect(args.at(-1)).toBe('rec-%Y%m%d-%H%M%S.ts')
    expect(args).toContain('title=Cafe East')
  })
})

describe('buildNormalizeTsRemuxArgs', () => {
  it('rebases A/V PTS with setts bitstream filter', () => {
    const args = buildNormalizeTsRemuxArgs({
      inputPath: 'in.ts',
      outputPath: 'out.ts',
    })
    expect(args).toContain('-map')
    expect(args).toContain('0:v:0')
    expect(args).toContain('0:a:0?')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).toContain('-bsf:v')
    expect(args).toContain('setts=ts=PTS-STARTPTS')
    expect(args).toContain('-bsf:a')
    expect(args).toContain('mpegts')
    expect(args.at(-1)).toBe('out.ts')
  })

  it('can drop audio map', () => {
    const args = buildNormalizeTsRemuxArgs({
      inputPath: 'in.ts',
      outputPath: 'out.ts',
      includeAudio: false,
    })
    expect(args).not.toContain('0:a:0?')
    expect(args).not.toContain('-bsf:a')
  })
})

describe('buildMpegtsPreviewArgs', () => {
  it('builds low-latency mpegts remux to pipe', () => {
    const args = buildMpegtsPreviewArgs({
      inputUrl: 'rtsp://cam/stream',
    })
    expect(args).toContain('nobuffer+genpts+discardcorrupt')
    expect(args).toContain('low_delay')
    expect(args).toContain('-an')
    expect(args).toContain('-c:v')
    expect(args).toContain('copy')
    expect(args).toContain('mpegts')
    expect(args).toContain('1000000')
    expect(args).not.toContain('h264_mp4toannexb')
    expect(args.at(-1)).toBe('pipe:1')
  })
})

describe('buildFmp4PlaybackRemuxArgs', () => {
  it('stream-copies TS to fragmented MP4 on stdout', () => {
    const args = buildFmp4PlaybackRemuxArgs({
      inputPath: 'D:\\rec\\cam\\a.ts',
      startSec: 12.5,
    })
    expect(args).toContain('-ss')
    expect(args).toContain('12.500')
    expect(args).toContain('-i')
    expect(args).toContain('D:\\rec\\cam\\a.ts')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).not.toContain('libx264')
    expect(args).not.toContain('libx265')
    expect(args).toContain('-movflags')
    expect(args).toContain('+frag_keyframe+empty_moov+default_base_moof')
    expect(args).toContain('-f')
    expect(args).toContain('mp4')
    expect(args.at(-1)).toBe('pipe:1')
  })
})

describe('buildFaststartPlaybackRemuxArgs', () => {
  it('writes moov-at-front MP4 for Chromium native demux', () => {
    const args = buildFaststartPlaybackRemuxArgs({
      inputPath: 'a.ts',
      outputPath: 'out.mp4',
      startSec: 5,
      includeAudio: false,
    })
    expect(args).toContain('-ss')
    expect(args).toContain('5.000')
    expect(args).toContain('-movflags')
    expect(args).toContain('+faststart')
    expect(args).not.toContain('0:a:0?')
    expect(args.at(-1)).toBe('out.mp4')
  })
})

describe('buildProbeArgs', () => {
  it('opens stream briefly into null muxer', () => {
    const args = buildProbeArgs({ inputUrl: 'rtsp://cam/stream', durationSec: 2 })
    expect(args).toContain('-t')
    expect(args).toContain('2')
    expect(args).toContain('null')
  })
})

describe('sanitizeFileStem', () => {
  it('strips unsafe chars', () => {
    expect(sanitizeFileStem('Cafe East')).toBe('Cafe_East')
    expect(sanitizeFileStem('a/b:c')).toBe('a_b_c')
  })
})
