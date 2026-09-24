import { Tray, Menu, type BrowserWindow } from 'electron'
import { loadTrayIcon } from './app-icon'

export type TrayController = {
  destroy: () => void
  /** Show / focus main window (recreates via ensureMainWindow if needed). */
  showMain: () => void
  hideToTray: () => void
  /**
   * Tray glyph visibility. Normally kept visible for the whole process lifetime.
   */
  setIconVisible: (visible: boolean) => void
}

export function createAppTray(opts: {
  getMainWindow: () => BrowserWindow | null
  ensureMainWindow: () => void
  onQuit: () => void
  /** Create tray glyph immediately. Default true. */
  initialIconVisible?: boolean
}): TrayController {
  let tray: Tray | null = null

  const showMain = () => {
    opts.ensureMainWindow()
    const win = opts.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const hideToTray = () => {
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) win.hide()
  }

  const bindTray = (t: Tray) => {
    t.setToolTip('Navora Monitor')
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 Navora Monitor', click: () => showMain() },
        { label: '隐藏到托盘', click: () => hideToTray() },
        { type: 'separator' },
        { label: '退出', click: () => opts.onQuit() },
      ]),
    )
    t.on('double-click', () => showMain())
    t.on('click', () => {
      if (process.platform === 'darwin') return
      const win = opts.getMainWindow()
      if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) hideToTray()
      else showMain()
    })
  }

  const setIconVisible = (visible: boolean) => {
    if (visible) {
      if (tray) return
      tray = new Tray(loadTrayIcon())
      bindTray(tray)
      return
    }
    if (!tray) return
    try {
      tray.destroy()
    } catch {
      /* ignore */
    }
    tray = null
  }

  if (opts.initialIconVisible !== false) setIconVisible(true)

  return {
    destroy: () => setIconVisible(false),
    showMain,
    hideToTray,
    setIconVisible,
  }
}
