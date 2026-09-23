import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild } from 'esbuild'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const electronPath = /** @type {string} */ (require('electron'))
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function buildElectron() {
  const outdir = join(root, 'dist-electron')
  mkdirSync(outdir, { recursive: true })
  await esbuild({
    entryPoints: [join(root, 'electron/main.ts')],
    outfile: join(outdir, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  })
  await esbuild({
    entryPoints: [join(root, 'electron/preload.ts')],
    outfile: join(outdir, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  })
}

const server = await createServer({
  configFile: join(root, 'vite.config.ts'),
  root,
})
await server.listen()
const urls = server.resolvedUrls
const url = urls?.local?.[0] ?? urls?.network?.[0]
console.log('[navora-monitor] Vite:', url)
if (!url) throw new Error('vite server has no local url')

await buildElectron()
console.log('[navora-monitor] launching Electron…')

const child = spawn(electronPath, ['.'], {
  cwd: root,
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
  stdio: 'inherit',
})

child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
