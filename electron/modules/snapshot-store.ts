import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeFileStem } from '../../shared/ffmpeg-args'
import { ensureDir, snapshotsRoot } from './data-root'

export { snapshotsRoot }

export function saveSnapshotJpeg(
  channelId: string,
  dataUrl: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const m = /^data:image\/jpeg;base64,(.+)$/i.exec(dataUrl)
  if (!m) return { ok: false, error: '无效截图数据' }
  const dir = join(snapshotsRoot(), channelId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${sanitizeFileStem(channelId)}-${stamp}.jpg`)
  try {
    ensureDir(dir)
    writeFileSync(file, Buffer.from(m[1], 'base64'))
    return { ok: true, path: file }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '写入失败' }
  }
}
