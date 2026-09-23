/**
 * Package Navora Monitor with the correct bundled FFmpeg for each target.
 *
 * Usage:
 *   node scripts/pack.mjs                      # host win/linux x64 defaults
 *   node scripts/pack.mjs --all                # win-x64 + win-arm64 + linux-x64 + linux-arm64
 *   node scripts/pack.mjs win-x64
 *   node scripts/pack.mjs win-arm64 --dir
 *   node scripts/pack.mjs linux-x64 AppImage
 *   node scripts/pack.mjs linux-arm64 tar.gz
 *
 * Extra args after the target are forwarded to electron-builder
 * (e.g. nsis, portable, AppImage, tar.gz, --dir).
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @typedef {{ id: string, platform: 'win' | 'linux', arch: 'x64' | 'arm64', ffmpegDirs: string[], exe: string }} PackTarget */

/** @type {Record<string, PackTarget>} */
const TARGETS = {
  'win-x64': {
    id: 'win-x64',
    platform: 'win',
    arch: 'x64',
    ffmpegDirs: ['win-x64', 'win64'],
    exe: 'ffmpeg.exe',
  },
  'win-arm64': {
    id: 'win-arm64',
    platform: 'win',
    arch: 'arm64',
    ffmpegDirs: ['win-arm64'],
    exe: 'ffmpeg.exe',
  },
  'linux-x64': {
    id: 'linux-x64',
    platform: 'linux',
    arch: 'x64',
    ffmpegDirs: ['linux-x64', 'linux64'],
    exe: 'ffmpeg',
  },
  'linux-arm64': {
    id: 'linux-arm64',
    platform: 'linux',
    arch: 'arm64',
    ffmpegDirs: ['linux-arm64'],
    exe: 'ffmpeg',
  },
}

const ALL_IDS = Object.keys(TARGETS)

function hostTargetId() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `win-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  // mac host: default to linux-x64 artifacts for CI convenience is wrong — require explicit
  console.warn(`[pack] Host ${process.platform}/${process.arch} — defaulting to win-x64`)
  return 'win-x64'
}

function resolveFfmpegDir(target) {
  for (const dir of target.ffmpegDirs) {
    const p = join(root, 'vendor', 'ffmpeg', dir)
    if (existsSync(join(p, target.exe))) return p
  }
  return null
}

function parseArgs(argv) {
  const all = argv.includes('--all')
  const rest = argv.filter((a) => a !== '--all')
  /** @type {string[]} */
  const targetIds = []
  /** @type {string[]} */
  const builderExtra = []

  for (const a of rest) {
    if (TARGETS[a] || a === 'win' || a === 'linux') {
      if (a === 'win') {
        targetIds.push('win-x64')
      } else if (a === 'linux') {
        targetIds.push('linux-x64')
      } else {
        targetIds.push(a)
      }
    } else {
      builderExtra.push(a)
    }
  }

  if (all) {
    return { targetIds: [...ALL_IDS], builderExtra }
  }
  if (!targetIds.length) {
    return { targetIds: [hostTargetId()], builderExtra }
  }
  return { targetIds, builderExtra }
}

function defaultBuilderArgs(target, extra) {
  if (extra.length) return extra
  if (target.platform === 'win') {
    // Default: both NSIS + portable (matches previous dist behavior)
    return []
  }
  // Linux default: AppImage + tar.gz
  return ['AppImage', 'tar.gz']
}

function runBuilder(target, extra) {
  const ffmpegDir = resolveFfmpegDir(target)
  if (!ffmpegDir) {
    console.error(`[pack] Missing FFmpeg for ${target.id}`)
    console.error(`  Expected one of: ${target.ffmpegDirs.map((d) => `vendor/ffmpeg/${d}/${target.exe}`).join(', ')}`)
    console.error(`  Run: npm run ffmpeg:fetch -- ${target.id}`)
    return 1
  }

  const builderArgs = [
    `--${target.platform}`,
    `--${target.arch}`,
    ...defaultBuilderArgs(target, extra),
    `-c.extraResources[0].from=${ffmpegDir}`,
    `-c.extraResources[0].to=ffmpeg`,
    `-c.extraResources[0].filter[0]=**/*`,
  ]

  console.log(`\n[pack] ${target.id}`)
  console.log(`[pack] FFmpeg ← ${ffmpegDir}`)
  console.log(`[pack] electron-builder ${builderArgs.join(' ')}`)

  const env = {
    ...process.env,
    ELECTRON_MIRROR:
      process.env.ELECTRON_MIRROR ||
      process.env.electron_mirror ||
      'https://npmmirror.com/mirrors/electron/',
  }

  const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-builder', ...builderArgs],
    { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  return r.status ?? 1
}

function main() {
  const { targetIds, builderExtra } = parseArgs(process.argv.slice(2))
  let code = 0
  for (const id of targetIds) {
    const target = TARGETS[id]
    if (!target) {
      console.error(`[pack] Unknown target: ${id}`)
      console.error(`[pack] Known: ${ALL_IDS.join(', ')}`)
      process.exit(1)
    }
    // When packing multiple targets, only pass builderExtra that are universal flags like --dir
    // Platform-specific format args (nsis/AppImage) apply per invocation.
    const status = runBuilder(target, builderExtra)
    if (status !== 0) {
      code = status
      console.error(`[pack] Failed: ${id} (exit ${status})`)
      break
    }
  }
  process.exit(code)
}

main()
