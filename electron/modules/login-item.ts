import { app } from 'electron'
import type { AppSettings } from '../../shared/settings'

/**
 * Sync OS login item with settings.
 * Only applies when packaged — dev Electron path would register the wrong binary.
 */
export function applyOpenAtLogin(settings: Pick<AppSettings, 'openAtLogin' | 'showMainOnStartup'>) {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.openAtLogin,
      openAsHidden: !settings.showMainOnStartup,
      path: process.execPath,
      args: [],
    })
  } catch (err) {
    console.warn('[login-item] setLoginItemSettings failed:', err)
  }
}

/** Read whether the OS currently has us registered (packaged only). */
export function readOpenAtLogin(): boolean | null {
  if (!app.isPackaged) return null
  try {
    return !!app.getLoginItemSettings().openAtLogin
  } catch {
    return null
  }
}
