import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const src = resolve('dist')
const dest = resolve('server/internal/webui/files')
mkdirSync(dest, { recursive: true })
for (const entry of readdirSync(dest)) {
  if (entry !== '.gitkeep') rmSync(resolve(dest, entry), { recursive: true, force: true })
}
cpSync(src, dest, { recursive: true })
console.log('staged web UI into', dest)
