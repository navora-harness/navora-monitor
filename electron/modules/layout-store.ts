import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultUiLayout, sanitizeUiLayout, type UiLayoutState } from '../../shared/panel-sizes'
import { ensureDir, getDataRoot } from './data-root'

const FILE = 'layout.json'

export function loadLayout(dataRoot = getDataRoot()): UiLayoutState {
  ensureDir(dataRoot)
  const p = join(dataRoot, FILE)
  if (!existsSync(p)) return defaultUiLayout()
  try {
    return sanitizeUiLayout(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return defaultUiLayout()
  }
}

export function saveLayout(layout: UiLayoutState, dataRoot = getDataRoot()): UiLayoutState {
  ensureDir(dataRoot)
  const clean = sanitizeUiLayout(layout)
  writeFileSync(join(dataRoot, FILE), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}
