import { app } from 'electron'
import { join, resolve } from 'node:path'
import { APP_NAME } from '../../shared/app-meta'
import { ensureDir, getConfigRoot, getDataRoot } from './config-root'
import { loadSettings } from './settings-store'

export { ensureDir, getConfigRoot, getDataRoot }

/**
 * Default media library under the OS Videos folder:
 *   <Videos>/Navora Monitor/{recordings,saved,snapshots}
 * Falls back to <configRoot>/media if Videos is unavailable.
 * Config / write-cache stay under getConfigRoot() (faster local disk).
 */
export function defaultMediaLibraryRoot(): string {
  try {
    const dir = join(app.getPath('videos'), APP_NAME)
    ensureDir(dir)
    return dir
  } catch (err) {
    console.warn('[data-root] Videos library unavailable, using config media/', err)
    const fallback = join(getConfigRoot(), 'media')
    ensureDir(fallback)
    return fallback
  }
}

export function recordingsRoot(): string {
  const s = loadSettings()
  const dir = s.recordingsPath || join(defaultMediaLibraryRoot(), 'recordings')
  ensureDir(dir)
  return dir
}

export function snapshotsRoot(): string {
  const s = loadSettings()
  const dir = s.snapshotsPath || join(defaultMediaLibraryRoot(), 'snapshots')
  ensureDir(dir)
  return dir
}

export function channelRecordDir(channelId: string): string {
  const dir = join(recordingsRoot(), channelId)
  ensureDir(dir)
  return dir
}

export function recordCacheRoot(): string {
  const s = loadSettings()
  const dir = s.recordCachePath || join(getConfigRoot(), 'record-cache')
  ensureDir(dir)
  return dir
}

export function channelCacheDir(channelId: string): string {
  const dir = join(recordCacheRoot(), channelId)
  ensureDir(dir)
  return dir
}

/** True when FFmpeg should write to local cache then flush to archive. */
export function isRecordCacheActive(): boolean {
  const s = loadSettings()
  if (!s.recordCacheEnabled) return false
  try {
    return resolve(recordCacheRoot()) !== resolve(recordingsRoot())
  } catch {
    return false
  }
}

/**
 * Directory FFmpeg should write segments into (cache or final).
 */
export function channelWriteDir(channelId: string): { dir: string; cached: boolean } {
  if (isRecordCacheActive()) {
    return { dir: channelCacheDir(channelId), cached: true }
  }
  return { dir: channelRecordDir(channelId), cached: false }
}

/** Tesla-style SavedClips — never auto-deleted. */
export function savedClipsRoot(): string {
  const s = loadSettings()
  const dir = s.savedClipsPath || join(defaultMediaLibraryRoot(), 'saved')
  ensureDir(dir)
  return dir
}

export function channelSavedDir(channelId: string): string {
  const dir = join(savedClipsRoot(), channelId)
  ensureDir(dir)
  return dir
}

export function previewRoot(): string {
  const dir = join(getConfigRoot(), 'preview')
  ensureDir(dir)
  return dir
}
