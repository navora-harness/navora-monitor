import * as esbuild from 'esbuild'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'dist-electron')
mkdirSync(outdir, { recursive: true })

await esbuild.build({
  entryPoints: [join(root, 'electron/main.ts')],
  outfile: join(outdir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
})

await esbuild.build({
  entryPoints: [join(root, 'electron/preload.ts')],
  outfile: join(outdir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info',
})

const assetsSrc = join(root, 'electron', 'assets')
const assetsDest = join(outdir, 'assets')
if (existsSync(assetsSrc)) {
  mkdirSync(assetsDest, { recursive: true })
  cpSync(assetsSrc, assetsDest, { recursive: true })
}

console.log('electron main/preload built → dist-electron/')
