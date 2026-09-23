import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ENV_KEYS = ['NAVORA_MONITOR_FFMPEG', 'FFMPEG_PATH'] as const

/** Set by esbuild for the Electron main bundle (CJS). */
declare const __dirname: string

function vendorPlatformDirs(): string[] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') {
    return arch === 'arm64' ? ['win-arm64'] : ['win-x64', 'win64']
  }
  if (process.platform === 'linux') {
    return arch === 'arm64' ? ['linux-arm64'] : ['linux-x64', 'linux64']
  }
  if (process.platform === 'darwin') {
    return arch === 'arm64' ? ['darwin-arm64'] : ['darwin-x64']
  }
  return []
}

function bundledCandidates(): string[] {
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dirs = vendorPlatformDirs()
  const out: string[] = []

  // Packaged Electron: electron-builder extraResources → resources/ffmpeg/
  if (process.resourcesPath) {
    out.push(join(process.resourcesPath, 'ffmpeg', exeName))
    for (const dir of dirs) {
      out.push(join(process.resourcesPath, 'ffmpeg', dir, exeName))
    }
  }

  // Dev: project root is cwd when launched via scripts/dev.mjs
  for (const dir of dirs) {
    out.push(join(process.cwd(), 'vendor', 'ffmpeg', dir, exeName))
  }
  out.push(join(process.cwd(), 'vendor', 'ffmpeg', exeName))

  // Relative to dist-electron/main.cjs → ../vendor/ffmpeg/...
  try {
    for (const dir of dirs) {
      out.push(join(__dirname, '..', 'vendor', 'ffmpeg', dir, exeName))
    }
    out.push(join(__dirname, 'ffmpeg', exeName))
  } catch {
    /* __dirname may be missing outside the bundle */
  }

  try {
    // Lazy require — keeps this module importable outside Electron
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    const app = electron.app
    if (app) {
      const appPath = app.getAppPath()
      for (const dir of dirs) {
        out.push(join(appPath, 'vendor', 'ffmpeg', dir, exeName))
      }
    }
  } catch {
    /* not running under Electron */
  }

  return out
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return null
}

export function resolveBundledFfmpegPath(): string | null {
  return firstExisting(bundledCandidates())
}

export function resolveFfmpegPath(preferred?: string | null): string | null {
  if (preferred && existsSync(preferred)) return preferred

  for (const key of ENV_KEYS) {
    const p = process.env[key]
    if (p && existsSync(p)) return p
  }

  const bundled = resolveBundledFfmpegPath()
  if (bundled) return bundled

  const which = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(which, ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (out && existsSync(out)) return out
  } catch {
    /* not on PATH */
  }

  if (process.platform === 'win32') {
    const candidates = [
      join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      join('C:\\ffmpeg', 'bin', 'ffmpeg.exe'),
    ]
    for (const c of candidates) {
      if (c && existsSync(c)) return c
    }
  }

  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    const exe = process.platform === 'win32' ? join(dir, 'ffmpeg.exe') : join(dir, 'ffmpeg')
    if (existsSync(exe)) return exe
  }

  return null
}

export function probeFfmpeg(ffmpegPath: string): boolean {
  try {
    execFileSync(ffmpegPath, ['-version'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}
