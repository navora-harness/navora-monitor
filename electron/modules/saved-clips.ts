import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { segmentInSaveWindow } from '../../shared/saved-clip'
import type { RecordingSegment } from '../../shared/types'
import {
  channelCacheDir,
  channelRecordDir,
  channelSavedDir,
  isRecordCacheActive,
  savedClipsRoot,
} from './data-root'
import type { MediaServer } from './media-server'
import { loadSettings } from './settings-store'

export type SaveClipResult =
  | {
      ok: true
      channelId: string
      copied: number
      durationSec: number
      clips: RecordingSegment[]
      message: string
    }
  | { ok: false; error: string }

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function listMp4InDir(dir: string): Array<{ path: string; fileName: string; sizeBytes: number; mtimeMs: number }> {
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; fileName: string; sizeBytes: number; mtimeMs: number }> = []
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.mp4')) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (!st.isFile() || st.size < 64) continue
      out.push({ path, fileName: name, sizeBytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* ignore */
    }
  }
  return out
}

/** Source dirs that may hold recent loop footage for a channel. */
function sourceDirsForChannel(channelId: string): string[] {
  const dirs = [channelRecordDir(channelId)]
  if (isRecordCacheActive()) dirs.push(channelCacheDir(channelId))
  return dirs
}

/**
 * Copy recent loop segments into the protected SavedClips folder.
 * Files under saved/ are never touched by retention or emergency cleanup.
 */
export function saveRecentClip(channelId: string, durationSec?: number): SaveClipResult {
  const settings = loadSettings()
  const dur = Math.max(
    30,
    Math.min(3600, Math.round(durationSec ?? settings.savedClipDurationSec ?? 600)),
  )
  const segmentTime = settings.defaultSegmentTimeSec || 300
  const now = Date.now()
  const candidates: Array<{ path: string; fileName: string; sizeBytes: number; mtimeMs: number }> = []
  const seen = new Set<string>()

  for (const dir of sourceDirsForChannel(channelId)) {
    for (const f of listMp4InDir(dir)) {
      if (seen.has(f.fileName)) continue
      if (
        !segmentInSaveWindow({
          endMs: f.mtimeMs,
          segmentTimeSec: segmentTime,
          windowEndMs: now,
          durationSec: dur,
        })
      ) {
        continue
      }
      seen.add(f.fileName)
      candidates.push(f)
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      error: `最近 ${Math.round(dur / 60)} 分钟内没有可保存的录像分段（请先开始录像）`,
    }
  }

  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const destDir = channelSavedDir(channelId)
  const prefix = stamp()
  const clips: RecordingSegment[] = []
  let copied = 0

  for (const f of candidates) {
    const destName = `${prefix}_${f.fileName}`
    const destPath = join(destDir, destName)
    try {
      copyFileSync(f.path, destPath)
      const st = statSync(destPath)
      clips.push({
        id: `saved/${channelId}/${destName}`,
        channelId,
        fileName: destName,
        path: destPath,
        url: '', // filled by caller with media server
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        startMs: st.mtimeMs - segmentTime * 1000,
        endMs: st.mtimeMs,
        protected: true,
        savedAt: Date.now(),
      })
      copied += 1
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : '复制到已保存目录失败',
      }
    }
  }

  return {
    ok: true,
    channelId,
    copied,
    durationSec: dur,
    clips,
    message: `已保存 ${copied} 个分段（约最近 ${Math.round(dur / 60)} 分钟），不会被自动清理`,
  }
}

export function listSavedClips(media: MediaServer, channelId?: string): RecordingSegment[] {
  const root = savedClipsRoot()
  if (!existsSync(root)) return []
  const channels = channelId
    ? [channelId]
    : readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)

  const segmentTime = loadSettings().defaultSegmentTimeSec || 300
  const out: RecordingSegment[] = []
  for (const id of channels) {
    const dir = join(root, id)
    for (const f of listMp4InDir(dir)) {
      out.push({
        id: `saved/${id}/${f.fileName}`,
        channelId: id,
        fileName: f.fileName,
        path: f.path,
        url: media.savedClipUrl(id, f.fileName),
        sizeBytes: f.sizeBytes,
        mtimeMs: f.mtimeMs,
        startMs: f.mtimeMs - segmentTime * 1000,
        endMs: f.mtimeMs,
        protected: true,
        savedAt: f.mtimeMs,
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

export function deleteSavedClip(segmentId: string): { ok: true } | { ok: false; error: string } {
  // id format: saved/<channelId>/<fileName>
  if (!segmentId.startsWith('saved/')) {
    return { ok: false, error: '只能删除已保存的受保护片段' }
  }
  const parts = segmentId.split('/')
  if (parts.length < 3) return { ok: false, error: '无效的片段 ID' }
  const channelId = parts[1]!
  const fileName = parts.slice(2).join('/')
  if (!fileName.toLowerCase().endsWith('.mp4') || fileName.includes('..')) {
    return { ok: false, error: '无效的文件名' }
  }
  const path = join(channelSavedDir(channelId), basename(fileName))
  if (!existsSync(path)) return { ok: false, error: '文件不存在' }
  try {
    unlinkSync(path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '删除失败' }
  }
}

export function sumSavedClipBytes(root = savedClipsRoot()): number {
  if (!existsSync(root)) return 0
  let total = 0
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    for (const f of listMp4InDir(join(root, name.name))) total += f.sizeBytes
  }
  return total
}
