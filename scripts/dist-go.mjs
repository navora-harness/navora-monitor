/**
 * Package the Go web service for one or more platforms.
 *
 *   node scripts/dist-go.mjs                 # win-x64 portable + setup + linux-x64 portable
 *   node scripts/dist-go.mjs portable        # same targets, zip only (no NSIS)
 *   node scripts/dist-go.mjs setup           # win-x64 installer only
 *   node scripts/dist-go.mjs win-x64         # one target
 *   node scripts/dist-go.mjs linux-x64 linux-arm64
 *   node scripts/dist-go.mjs --targets win-x64,linux-x64 portable
 *
 * Cross-compiles with CGO_ENABLED=0. Matching FFmpeg is fetched into vendor/ when missing.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version || '0.0.0'
const releaseDir = join(root, 'release')

/** @typedef {{ id: string, goos: string, goarch: string, exe: string, ffmpegId: string, ffmpegBin: string }} Target */

/** @type {Record<string, Target>} */
const TARGETS = {
  'win-x64': {
    id: 'win-x64',
    goos: 'windows',
    goarch: 'amd64',
    exe: 'navora.exe',
    ffmpegId: 'win-x64',
    ffmpegBin: 'ffmpeg.exe',
  },
  'win-arm64': {
    id: 'win-arm64',
    goos: 'windows',
    goarch: 'arm64',
    exe: 'navora.exe',
    ffmpegId: 'win-arm64',
    ffmpegBin: 'ffmpeg.exe',
  },
  'linux-x64': {
    id: 'linux-x64',
    goos: 'linux',
    goarch: 'amd64',
    exe: 'navora',
    ffmpegId: 'linux-x64',
    ffmpegBin: 'ffmpeg',
  },
  'linux-arm64': {
    id: 'linux-arm64',
    goos: 'linux',
    goarch: 'arm64',
    exe: 'navora',
    ffmpegId: 'linux-arm64',
    ffmpegBin: 'ffmpeg',
  },
}

function parseArgs(argv) {
  let mode = 'all'
  /** @type {string[]} */
  const ids = []
  for (const a of argv) {
    if (a === 'portable' || a === 'setup' || a === 'all') {
      mode = a
      continue
    }
    if (a.startsWith('--targets=')) {
      ids.push(...a.slice('--targets='.length).split(',').map((s) => s.trim()).filter(Boolean))
      continue
    }
    if (a === '--targets') continue
    if (TARGETS[a]) ids.push(a)
    else {
      console.error(`[dist-go] unknown arg: ${a}`)
      console.error(`[dist-go] targets: ${Object.keys(TARGETS).join(', ')}`)
      console.error('[dist-go] modes: portable | setup | all')
      process.exit(1)
    }
  }
  if (!ids.length) {
    if (mode === 'setup') ids.push('win-x64')
    else ids.push('win-x64', 'linux-x64')
  }
  return { mode, ids }
}

function run(cmd, args, opts = {}) {
  const useShell = opts.shell === true || (opts.shell !== false && process.platform === 'win32' && typeof cmd === 'string' && !cmd.includes('\\') && !cmd.includes('/'))
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts, shell: useShell })
  if (res.status !== 0) {
    console.error(`[dist-go] ${cmd} ${args.join(' ')} failed (${res.status ?? res.error?.message})`)
    process.exit(res.status || 1)
  }
}

function findMakensis() {
  const candidates = [
    'makensis',
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ]
  for (const c of candidates) {
    const res = spawnSync(c, ['/VERSION'], { encoding: 'utf8', shell: false })
    if (res.status === 0) return c
  }
  return null
}

function ensureFfmpeg(ffmpegId, { optional = false } = {}) {
  const names = ffmpegId.startsWith('win') ? ['ffmpeg.exe'] : ['ffmpeg']
  const aliases = ffmpegId === 'win-x64' ? ['win-x64', 'win64'] : [ffmpegId]
  for (const dir of aliases) {
    for (const name of names) {
      const p = join(root, 'vendor', 'ffmpeg', dir, name)
      if (existsSync(p)) return { exe: p, dir: join(root, 'vendor', 'ffmpeg', dir) }
    }
  }
  if (optional) {
    console.warn(`[dist-go] FFmpeg ${ffmpegId} not in vendor/; packaging without bundled binary`)
    return null
  }
  console.log(`[dist-go] fetching FFmpeg ${ffmpegId}`)
  const fetch = spawnSync(process.execPath, [join(root, 'scripts', 'fetch-ffmpeg.mjs'), ffmpegId], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  })
  for (const dir of aliases) {
    for (const name of names) {
      const p = join(root, 'vendor', 'ffmpeg', dir, name)
      if (existsSync(p)) return { exe: p, dir: join(root, 'vendor', 'ffmpeg', dir) }
    }
  }
  if (fetch.status !== 0) {
    console.warn(`[dist-go] FFmpeg ${ffmpegId} fetch failed; packaging without bundled binary`)
  }
  return null
}

function stageDir(target) {
  return join(releaseDir, `stage-${target.id}`)
}

/**
 * @param {Target} target
 * @param {'portable' | 'setup' | 'all'} mode
 */
function buildTarget(target, mode) {
  const stage = stageDir(target)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })

  console.log(`[dist-go] go build ${target.goos}/${target.goarch}`)
  run('go', ['build', '-ldflags=-s -w', '-o', join(stage, target.exe), './cmd/navora'], {
    cwd: join(root, 'server'),
    shell: false,
    env: {
      ...process.env,
      GOOS: target.goos,
      GOARCH: target.goarch,
      CGO_ENABLED: '0',
    },
  })

  const wantZip = mode === 'portable' || mode === 'all' || target.goos !== 'windows'
  const wantSetup = (mode === 'setup' || mode === 'all') && target.goos === 'windows'

  const ff = ensureFfmpeg(target.ffmpegId, { optional: target.goos !== 'windows' })
  if (ff) {
    mkdirSync(join(stage, 'ffmpeg'), { recursive: true })
    copyFileSync(ff.exe, join(stage, 'ffmpeg', target.ffmpegBin))
    const lic = join(ff.dir, 'LICENSE.txt')
    if (existsSync(lic)) copyFileSync(lic, join(stage, 'ffmpeg', 'LICENSE.txt'))
  } else {
    console.warn(`[dist-go] FFmpeg for ${target.ffmpegId} missing; package needs ffmpeg on PATH`)
  }

  mkdirSync(join(stage, 'portable'), { recursive: true })
  writeFileSync(join(stage, 'portable', '.gitkeep'), '')
  const readme =
    target.goos === 'windows'
      ? `Navora Monitor ${version} (${target.id})
绿色版：解压后双击 ${target.exe}。配置写在同目录 portable\\ 下。
首次启动会在这个窗口打印管理员账户和初始密码，只显示一次。
浏览器打开窗口里的本机地址即可使用。
FFmpeg 放在 ffmpeg\\ 目录；发行包内的 FFmpeg 遵循 GPLv3。
`
      : `Navora Monitor ${version} (${target.id})
Unpack, then run: ./${target.exe}
Config is stored under ./portable/
First launch prints the admin username and one-time password in the terminal.
Open the printed local URL in a browser.
Bundled FFmpeg is under ./ffmpeg/ (GPLv3).
`
  writeFileSync(join(stage, '使用说明.txt'), readme, 'utf8')
  writeFileSync(join(stage, 'README.txt'), readme, 'utf8')

  /** @type {string[]} */
  const outs = []

  if (wantZip) {
    const zipName = `NavoraMonitor-${version}-${target.id}-portable.zip`
    const zipPath = join(releaseDir, zipName)
    if (existsSync(zipPath)) rmSync(zipPath)
    if (process.platform === 'win32') {
      run(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`,
        ],
        { cwd: root, shell: false },
      )
    } else {
      run('tar', ['-a', '-c', '-f', zipPath, '-C', stage, '.'], { shell: false })
    }
    console.log(`[dist-go] portable ${zipPath}`)
    outs.push(zipPath)
  }

  if (wantSetup) {
    if (process.platform !== 'win32') {
      console.warn('[dist-go] installer is Windows-host-only; skipped')
    } else {
      const makensis = findMakensis()
      const out = join(releaseDir, `NavoraMonitor-${version}-${target.id}-setup.exe`)
      if (!makensis) {
        console.warn('[dist-go] 未找到 makensis，已跳过安装包。安装 NSIS 后重新执行 npm run dist:go:setup')
        console.warn('[dist-go] https://nsis.sourceforge.io/Download')
        if (mode === 'setup') process.exit(1)
      } else {
        const q = (p) => p.replace(/\\/g, '\\\\')
        run(
          makensis,
          [`/DVERSION=${version}`, `/DSTAGEDIR=${q(stage)}`, `/DOUTFILE=${q(out)}`, join(root, 'build', 'navora.nsi')],
          { shell: false },
        )
        console.log(`[dist-go] setup ${out}`)
        outs.push(out)
      }
    }
  }

  return outs
}

const { mode, ids } = parseArgs(process.argv.slice(2))
mkdirSync(releaseDir, { recursive: true })

console.log(`[dist-go] build web ${version}`)
run('npm', ['run', 'build'], { cwd: root })

/** @type {string[]} */
const allOuts = []
for (const id of ids) {
  const target = TARGETS[id]
  console.log(`[dist-go] --- ${target.id} (${mode}) ---`)
  allOuts.push(...buildTarget(target, mode))
}

console.log('[dist-go] done:')
for (const p of allOuts) console.log(`  ${p}`)
