import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from '../../shared/settings'
import { ensureDir, getConfigRoot } from './config-root'

const FILE = 'settings.json'
let cache: AppSettings | null = null

function filePath(): string {
  return join(getConfigRoot(), FILE)
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  ensureDir(getConfigRoot())
  const p = filePath()
  if (!existsSync(p)) {
    cache = { ...DEFAULT_SETTINGS }
    writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8')
    return cache
  }
  try {
    cache = sanitizeSettings(JSON.parse(readFileSync(p, 'utf8')))
    return cache
  } catch {
    cache = { ...DEFAULT_SETTINGS }
    return cache
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = sanitizeSettings({ ...loadSettings(), ...patch })
  ensureDir(getConfigRoot())
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8')
  cache = next
  return next
}

/** Overwrite settings.json with a full sanitized document. */
export function replaceSettings(next: AppSettings): AppSettings {
  const clean = sanitizeSettings(next)
  ensureDir(getConfigRoot())
  writeFileSync(filePath(), JSON.stringify(clean, null, 2), 'utf8')
  cache = clean
  return clean
}

export function clearSettingsCache() {
  cache = null
}
