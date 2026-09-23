import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadChannels, saveChannels } from './channel-store'
import { ensureDir, getDataRoot, previewRoot, recordingsRoot, snapshotsRoot } from './data-root'
import { loadSettings, saveSettings } from './settings-store'
import type { PreviewManager } from './preview-manager'
import type { RecorderManager } from './recorder-manager'

export type RepairReport = {
  ok: boolean
  messages: string[]
  channelCount: number
}

/**
 * Repair app configuration & directories:
 * - rewrite sanitized channels.json (drop invalid / dedupe ids)
 * - ensure recordings / snapshots / preview / config dirs
 * - rewrite settings.json
 * - clear stale preview cache dirs for removed channels
 * - refresh ffmpeg resolution
 */
export function repairConfiguration(opts: {
  recorders: RecorderManager
  previews: PreviewManager
  activePreviewIds?: string[]
}): RepairReport {
  const messages: string[] = []

  ensureDir(getDataRoot())
  ensureDir(recordingsRoot())
  ensureDir(snapshotsRoot())
  ensureDir(previewRoot())
  messages.push('已确保配置/录像/截图/预览目录存在')

  const settings = saveSettings(loadSettings())
  messages.push(
    `设置已重写（录像目录：${settings.recordingsPath || '默认'}，分段 ${settings.defaultSegmentTimeSec}s）`,
  )

  const raw = loadChannels()
  const seen = new Set<string>()
  const cleaned = []
  let dropped = 0
  for (const ch of raw) {
    if (!ch.id?.trim() || !ch.url?.trim()) {
      dropped += 1
      continue
    }
    if (seen.has(ch.id)) {
      dropped += 1
      continue
    }
    seen.add(ch.id)
    cleaned.push(ch)
  }
  saveChannels(cleaned)
  if (dropped) messages.push(`已清理 ${dropped} 条无效/重复通道`)
  else messages.push(`通道配置正常（${cleaned.length} 路）`)

  // Remove orphan preview dirs
  const previewDir = previewRoot()
  if (existsSync(previewDir)) {
    let removedPreview = 0
    for (const name of readdirSync(previewDir, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      if (!seen.has(name.name)) {
        try {
          rmSync(join(previewDir, name.name), { recursive: true, force: true })
          removedPreview += 1
        } catch {
          /* ignore */
        }
      }
    }
    if (removedPreview) messages.push(`已清理 ${removedPreview} 个孤立预览缓存`)
  }

  opts.recorders.refreshFfmpeg()
  opts.previews.refreshFfmpeg()
  const ff = opts.recorders.getFfmpegInfo()
  messages.push(ff.ok ? `FFmpeg 可用：${ff.path}` : '警告：未检测到可用 FFmpeg')

  // Restart previews for currently active mosaic slots
  const ids = (opts.activePreviewIds ?? []).filter((id) => seen.has(id))
  if (ids.length) {
    opts.previews.syncActive(ids, (id) => cleaned.find((c) => c.id === id))
    messages.push(`已刷新 ${ids.length} 路预览`)
  }

  return { ok: ff.ok, messages, channelCount: cleaned.length }
}
