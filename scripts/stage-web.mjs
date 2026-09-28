import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const src = resolve('dist')
const dest = resolve('server/internal/webui/files')
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('staged web UI into', dest)
