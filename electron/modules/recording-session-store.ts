import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, getConfigRoot } from './config-root'

const FILE = 'recording-session.json'

type RecordingSessionFile = {
  version: 1
  /** Channel ids that should resume recording after app restart */
  channelIds: string[]
}

function filePath(): string {
  return join(getConfigRoot(), FILE)
}

export function loadRecordingSession(): string[] {
  ensureDir(getConfigRoot())
  const p = filePath()
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<RecordingSessionFile>
    if (!Array.isArray(raw.channelIds)) return []
    return [...new Set(raw.channelIds.filter((id): id is string => typeof id === 'string' && !!id.trim()))]
  } catch {
    return []
  }
}

export function saveRecordingSession(channelIds: string[]): void {
  ensureDir(getConfigRoot())
  const clean = [...new Set(channelIds.filter(Boolean))]
  const doc: RecordingSessionFile = { version: 1, channelIds: clean }
  const p = filePath()
  const tmp = `${p}.${process.pid}.tmp`
  const body = JSON.stringify(doc, null, 2)
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, p)
  } catch {
    // Windows: replace existing
    try {
      if (existsSync(p)) unlinkSync(p)
      renameSync(tmp, p)
    } catch {
      try {
        writeFileSync(p, body, 'utf8')
      } finally {
        try {
          if (existsSync(tmp)) unlinkSync(tmp)
        } catch {
          /* ignore */
        }
      }
    }
  }
}
