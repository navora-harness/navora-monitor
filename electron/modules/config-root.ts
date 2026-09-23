import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** App config root: settings / channels / layout (not necessarily recordings). */
export function getConfigRoot(): string {
  const env = process.env.NAVORA_MONITOR_DATA_ROOT
  if (env) return env
  if (!app.isPackaged) {
    return join(process.cwd(), 'portable')
  }
  return join(app.getPath('userData'), 'data')
}

/** @deprecated alias — config root */
export function getDataRoot(): string {
  return getConfigRoot()
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
