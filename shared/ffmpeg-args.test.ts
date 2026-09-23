import { describe, expect, it } from 'vitest'
import { buildMpegtsPreviewArgs, buildProbeArgs, buildSegmentRecordArgs, sanitizeFileStem } from './ffmpeg-args'

describe('buildSegmentRecordArgs', () => {
  it('matches remux + segment pattern', () => {
    const args = buildSegmentRecordArgs({
      inputUrl: 'rtsp://user:pass@192.168.1.10:554/stream',
      outputPattern: 'rec-%03d.mp4',
      title: 'Cafe East',
      segmentTimeSec: 300,
    })
    expect(args).toContain('-rtsp_transport')
    expect(args).toContain('tcp')
    expect(args).toContain('-c')
    expect(args).toContain('copy')
    expect(args).toContain('-reset_timestamps')
    expect(args).toContain('-f')
    expect(args).toContain('segment')
    expect(args).toContain('-segment_time')
    expect(args).toContain('300')
    expect(args).toContain('-segment_format')
    expect(args).toContain('mp4')
    expect(args.at(-1)).toBe('rec-%03d.mp4')
    expect(args).toContain('title=Cafe East')
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
