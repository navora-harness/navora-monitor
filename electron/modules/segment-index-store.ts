import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './config-root'
import { channelRecordDir } from './data-root'

export type SegmentIndexEntry = {
  fileName: string
  startMs: number
  endMs: number
  durationMs: number
  sizeBytes: number
  /** When this entry was last verified / probed */
  indexedAt: number
}

type SegmentIndexFile = {
  version: 1
  segments: SegmentIndexEntry[]
}

function indexPath(channelId: string): string {
  return join(channelRecordDir(channelId), 'index.json')
}

export function loadSegmentIndex(channelId: string): Map<string, SegmentIndexEntry> {
  const map = new Map<string, SegmentIndexEntry>()
  const p = indexPath(channelId)
  if (!existsSync(p)) return map
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<SegmentIndexFile>
    if (!Array.isArray(raw.segments)) return map
    for (const s of raw.segments) {
      if (!s || typeof s.fileName !== 'string') continue
      if (!Number.isFinite(s.startMs) || !Number.isFinite(s.endMs)) continue
      map.set(s.fileName, {
        fileName: s.fileName,
        startMs: s.startMs,
        endMs: s.endMs,
        durationMs: Number.isFinite(s.durationMs) ? s.durationMs : Math.max(0, s.endMs - s.startMs),
        sizeBytes: Number.isFinite(s.sizeBytes) ? s.sizeBytes : 0,
        indexedAt: Number.isFinite(s.indexedAt) ? s.indexedAt : 0,
      })
    }
  } catch {
    /* ignore corrupt index */
  }
  return map
}

export function saveSegmentIndex(channelId: string, entries: Map<string, SegmentIndexEntry>): void {
  const dir = channelRecordDir(channelId)
  ensureDir(dir)
  const segments = [...entries.values()].sort((a, b) => a.startMs - b.startMs)
  const doc: SegmentIndexFile = { version: 1, segments }
  writeFileSync(indexPath(channelId), JSON.stringify(doc, null, 2), 'utf8')
}

export function upsertSegmentIndexEntry(channelId: string, entry: SegmentIndexEntry): void {
  const map = loadSegmentIndex(channelId)
  map.set(entry.fileName, entry)
  saveSegmentIndex(channelId, map)
}

export function removeSegmentIndexEntry(channelId: string, fileName: string): void {
  const map = loadSegmentIndex(channelId)
  if (!map.delete(fileName)) return
  saveSegmentIndex(channelId, map)
}
