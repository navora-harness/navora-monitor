import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingSegment } from '../../shared/types'
import { channelRecordDir, recordingsRoot } from './data-root'
import type { MediaServer } from './media-server'

export function listRecordingSegments(
  media: MediaServer,
  channelId?: string,
  segmentTimeSec = 300,
): RecordingSegment[] {
  const channels = channelId
    ? [channelId]
    : existsSync(recordingsRoot())
      ? readdirSync(recordingsRoot(), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : []

  const out: RecordingSegment[] = []
  for (const id of channels) {
    const dir = channelRecordDir(id)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.mp4')) continue
      const path = join(dir, name)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (!st.isFile() || st.size < 64) continue
      const endMs = st.mtimeMs
      const startMs = endMs - segmentTimeSec * 1000
      out.push({
        id: `${id}/${name}`,
        channelId: id,
        fileName: name,
        path,
        url: media.recordingUrl(id, name),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        startMs,
        endMs,
        protected: false,
      })
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}
