/**
 * Download / refresh bundled FFmpeg builds (BtbN GPL).
 *
 * Usage:
 *   node scripts/fetch-ffmpeg.mjs              # host platform only
 *   node scripts/fetch-ffmpeg.mjs --all
 *   node scripts/fetch-ffmpeg.mjs win-x64 linux-x64
 *   node scripts/fetch-ffmpeg.mjs --force win-arm64
 */

import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(root, 'vendor', '.ffmpeg-cache')
const extractRoot = join(root, 'vendor', '.ffmpeg-extract')

/** @typedef {{ id: string, asset: string, archive: 'zip' | 'tar.xz', bin: string, destName: string }} FfmpegBuild */

/** @type {Record<string, FfmpegBuild>} */
const BUILDS = {
  'win-x64': {
    id: 'win-x64',
    asset: 'ffmpeg-master-latest-win64-gpl.zip',
    archive: 'zip',
    bin: 'bin/ffmpeg.exe',
    destName: 'ffmpeg.exe',
  },
  'win-arm64': {
    id: 'win-arm64',
    asset: 'ffmpeg-master-latest-winarm64-gpl.zip',
    archive: 'zip',
    bin: 'bin/ffmpeg.exe',
    destName: 'ffmpeg.exe',
  },
  'linux-x64': {
    id: 'linux-x64',
    asset: 'ffmpeg-master-latest-linux64-gpl.tar.xz',
    archive: 'tar.xz',
    bin: 'bin/ffmpeg',
    destName: 'ffmpeg',
  },
  'linux-arm64': {
    id: 'linux-arm64',
    asset: 'ffmpeg-master-latest-linuxarm64-gpl.tar.xz',
    archive: 'tar.xz',
    bin: 'bin/ffmpeg',
    destName: 'ffmpeg',
  },
}

const RELEASE_BASE =
  process.env.FFMPEG_RELEASE_BASE ||
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'

/** Reject truncated / empty cache entries (common after flaky CI downloads). */
const MIN_ARCHIVE_BYTES = 5 * 1024 * 1024

function authHeaders() {
  const token = process.env.FFMPEG_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
  /** @type {Record<string, string>} */
  const h = {
    'User-Agent': 'navora-monitor-ffmpeg-fetch',
    Accept: 'application/octet-stream',
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

function hostBuildId() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  throw new Error(`Unsupported host platform for bundled FFmpeg: ${process.platform}`)
}

function parseArgs(argv) {
  const force = argv.includes('--force')
  const all = argv.includes('--all')
  const ids = argv.filter((a) => !a.startsWith('--'))
  return { force, all, ids }
}

function archiveLooksValid(path) {
  try {
    return existsSync(path) && statSync(path).size >= MIN_ARCHIVE_BYTES
  } catch {
    return false
  }
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.partial`
  rmSync(tmp, { force: true })
  console.log(`Downloading ${url}`)

  let lastErr = /** @type {unknown} */ (null)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: authHeaders() })
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for ${url}`)
      }
      const file = createWriteStream(tmp)
      await pipeline(Readable.fromWeb(res.body), file)
      const size = statSync(tmp).size
      if (size < MIN_ARCHIVE_BYTES) {
        throw new Error(`Download too small (${size} bytes) for ${url}`)
      }
      rmSync(dest, { force: true })
      renameSync(tmp, dest)
      const mb = (size / 1024 / 1024).toFixed(1)
      console.log(`  → ${dest} (${mb} MB)`)
      return
    } catch (e) {
      lastErr = e
      rmSync(tmp, { force: true })
      console.warn(`  attempt ${attempt}/3 failed: ${e instanceof Error ? e.message : e}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function extractArchive(archivePath, outDir, kind) {
  mkdirSync(outDir, { recursive: true })
  if (kind === 'zip') {
    execFileSync('tar', ['-xf', archivePath, '-C', outDir], { stdio: 'inherit' })
    return
  }
  const r = spawnSync('tar', ['-xJf', archivePath, '-C', outDir], { stdio: 'inherit' })
  if (r.status !== 0) {
    throw new Error(`Failed to extract ${archivePath} (need tar with xz support)`)
  }
}

function findExtractedRoot(outDir) {
  for (const ent of readdirSync(outDir)) {
    const p = join(outDir, ent)
    if (statSync(p).isDirectory()) return p
  }
  throw new Error(`Extracted root not found under ${outDir}`)
}

async function fetchBuild(build, force) {
  const destDir = join(root, 'vendor', 'ffmpeg', build.id)
  const destBin = join(destDir, build.destName)
  if (!force && existsSync(destBin) && statSync(destBin).size > 1024 * 1024) {
    const mb = (statSync(destBin).size / 1024 / 1024).toFixed(1)
    console.log(`Skip ${build.id} (exists, ${mb} MB). Use --force to re-download.`)
    return
  }

  mkdirSync(cacheDir, { recursive: true })
  const archivePath = join(cacheDir, build.asset)
  const needDownload = force || !archiveLooksValid(archivePath)
  if (needDownload) {
    if (existsSync(archivePath) && !archiveLooksValid(archivePath)) {
      console.warn(`Discarding corrupt/partial cache ${archivePath}`)
      rmSync(archivePath, { force: true })
    }
    await download(`${RELEASE_BASE}/${build.asset}`, archivePath)
  } else {
    console.log(`Using cache ${archivePath} (${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB)`)
  }

  const tmp = join(extractRoot, build.id)
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  console.log(`Extracting ${build.asset}`)
  try {
    extractArchive(archivePath, tmp, build.archive)
  } catch (e) {
    // Corrupt cache → wipe and retry once.
    console.warn(`Extract failed for ${build.id}, re-downloading…`)
    rmSync(archivePath, { force: true })
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    await download(`${RELEASE_BASE}/${build.asset}`, archivePath)
    extractArchive(archivePath, tmp, build.archive)
  }

  const packRoot = findExtractedRoot(tmp)
  const binSrc = join(packRoot, ...build.bin.split('/'))
  const licSrc = join(packRoot, 'LICENSE.txt')
  if (!existsSync(binSrc)) {
    throw new Error(`Binary missing after extract: ${binSrc}`)
  }

  mkdirSync(destDir, { recursive: true })
  copyFileSync(binSrc, destBin)
  if (existsSync(licSrc)) copyFileSync(licSrc, join(destDir, 'LICENSE.txt'))

  // Legacy alias: win64 ← win-x64 (older docs / local paths)
  if (build.id === 'win-x64') {
    const legacy = join(root, 'vendor', 'ffmpeg', 'win64')
    mkdirSync(legacy, { recursive: true })
    copyFileSync(destBin, join(legacy, 'ffmpeg.exe'))
    if (existsSync(join(destDir, 'LICENSE.txt'))) {
      copyFileSync(join(destDir, 'LICENSE.txt'), join(legacy, 'LICENSE.txt'))
    }
  }

  rmSync(tmp, { recursive: true, force: true })
  const mb = (statSync(destBin).size / 1024 / 1024).toFixed(1)
  console.log(`Imported vendor/ffmpeg/${build.id}/${build.destName} (${mb} MB)`)
}

async function main() {
  const { force, all, ids } = parseArgs(process.argv.slice(2))
  const selected = ids.length ? ids : all ? Object.keys(BUILDS) : [hostBuildId()]

  for (const id of selected) {
    if (!BUILDS[id]) {
      console.error(`Unknown build id: ${id}`)
      console.error(`Known: ${Object.keys(BUILDS).join(', ')}`)
      process.exit(1)
    }
  }

  mkdirSync(join(root, 'vendor', 'ffmpeg'), { recursive: true })
  for (const id of selected) {
    console.log(`--- FFmpeg ${id} ---`)
    await fetchBuild(BUILDS[id], force)
  }
  console.log('Done.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
