/**
 * Legacy entry — prefer `npm run ffmpeg:fetch`.
 * Imports host FFmpeg (or pass ids) via fetch-ffmpeg.mjs.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const r = spawnSync(process.execPath, [join(root, 'scripts', 'fetch-ffmpeg.mjs'), ...args], {
  cwd: root,
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
