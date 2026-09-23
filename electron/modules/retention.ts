import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { recordingsRoot } from './data-root'
import { loadSettings } from './settings-store'

/** Delete recording segments older than settings.retentionDays (0 = skip). */
export function runRetentionCleanup(): { deleted: number } {
  const days = loadSettings().retentionDays
  if (!days || days <= 0) return { deleted: 0 }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const root = recordingsRoot()
  if (!existsSync(root)) return { deleted: 0 }

  let deleted = 0
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const dir = join(root, name.name)
    for (const file of readdirSync(dir)) {
      if (!file.toLowerCase().endsWith('.mp4')) continue
      const path = join(dir, file)
      try {
        const st = statSync(path)
        if (st.mtimeMs < cutoff) {
          unlinkSync(path)
          deleted += 1
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { deleted }
}
