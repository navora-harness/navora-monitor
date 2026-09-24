import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { recordingsRoot } from './data-root'

export type RecordingFile = {
  path: string
  sizeBytes: number
  mtimeMs: number
}

/** List loop recording segments under root (oldest first). */
export function listRecordingFiles(root = recordingsRoot()): RecordingFile[] {
  if (!existsSync(root)) return []
  const files: RecordingFile[] = []
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const dir = join(root, name.name)
    for (const file of readdirSync(dir)) {
      const lower = file.toLowerCase()
      if (!lower.endsWith('.ts') && !lower.endsWith('.mp4')) continue
      const path = join(dir, file)
      try {
        const st = statSync(path)
        files.push({ path, sizeBytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* ignore */
      }
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return files
}

export function sumRecordingBytes(root = recordingsRoot()): number {
  return listRecordingFiles(root).reduce((n, f) => n + f.sizeBytes, 0)
}

/**
 * Delete oldest segments until `freedBytes` reaches `needBytes` or no files left.
 * Returns deleted count and bytes freed (best-effort; does not re-stat disk).
 */
export function deleteOldestSegments(needBytes: number, root = recordingsRoot()): {
  deleted: number
  freedBytes: number
} {
  if (needBytes <= 0) return { deleted: 0, freedBytes: 0 }
  const files = listRecordingFiles(root)
  let deleted = 0
  let freedBytes = 0
  for (const f of files) {
    if (freedBytes >= needBytes) break
    try {
      unlinkSync(f.path)
      deleted += 1
      freedBytes += f.sizeBytes
    } catch {
      /* ignore locked files */
    }
  }
  return { deleted, freedBytes }
}

/** Delete every loop-recording MP4 under root (does not touch saved clips). */
export function deleteAllRecordingFiles(root = recordingsRoot()): {
  deleted: number
  freedBytes: number
} {
  const files = listRecordingFiles(root)
  let deleted = 0
  let freedBytes = 0
  for (const f of files) {
    try {
      unlinkSync(f.path)
      deleted += 1
      freedBytes += f.sizeBytes
    } catch {
      /* ignore locked / in-use files */
    }
  }
  return { deleted, freedBytes }
}
