import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const installJs = require.resolve('electron/install.js')

const env = {
  ...process.env,
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR ||
    process.env.electron_mirror ||
    'https://npmmirror.com/mirrors/electron/',
  electron_use_remote_checksums: process.env.electron_use_remote_checksums || '1',
}

const r = spawnSync(process.execPath, [installJs], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
