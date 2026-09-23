import { spawn } from 'node:child_process'
import { buildProbeArgs } from '../../../shared/ffmpeg-args'
import type { ChannelConfig, ProbeResult } from '../../../shared/types'
import { loadSettings } from '../settings-store'
import { resolveFfmpegPath, probeFfmpeg } from './resolve'

export async function probeChannel(channel: ChannelConfig): Promise<ProbeResult> {
  const preferred = loadSettings().ffmpegPath || null
  const ffmpeg = resolveFfmpegPath(preferred)
  if (!ffmpeg || !probeFfmpeg(ffmpeg)) {
    return { ok: false, error: '未找到可用的 ffmpeg', latencyMs: 0 }
  }

  const url = channel.previewUrl?.trim() || channel.url
  const args = buildProbeArgs({
    inputUrl: url,
    rtspTransport: channel.rtspTransport ?? 'tcp',
    durationSec: 3,
  })

  const started = Date.now()
  return await new Promise<ProbeResult>((resolve) => {
    const proc = spawn(ffmpeg, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        error: '探测超时（>15s）',
        latencyMs: Date.now() - started,
      })
    }, 15000)

    proc.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message, latencyMs: Date.now() - started })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      if (code === 0) {
        resolve({ ok: true, latencyMs, summary: `连通正常（${latencyMs} ms）` })
      } else {
        resolve({
          ok: false,
          error: stderr.trim() || `ffmpeg 退出 code=${code}`,
          latencyMs,
        })
      }
    })
  })
}
