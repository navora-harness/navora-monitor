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

const CLICK_DEBOUNCE_MS = 280

export function createAppTray(opts: {
  getMainWindow: () => BrowserWindow | null
  ensureMainWindow: () => void
  onQuit: () => void
  /** Destroy / hide main window while staying in tray. */
  dismissToTray?: () => void
  /** Create tray glyph immediately. Default true. */
  initialIconVisible?: boolean
}): TrayController {
  let tray: Tray | null = null
  let clickTimer: ReturnType<typeof setTimeout> | null = null

  const clearClickTimer = () => {
    if (!clickTimer) return
    clearTimeout(clickTimer)
    clickTimer = null
  }

  const showMain = () => {
    clearClickTimer()
    opts.ensureMainWindow()
    const win = opts.getMainWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  const hideToTray = () => {
    clearClickTimer()
    if (opts.dismissToTray) {
      opts.dismissToTray()
      return
    }
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed()) win.hide()
  }

  const bindTray = (t: Tray) => {
    t.setToolTip('Navora Monitor')
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 Navora Monitor', click: () => showMain() },
        { label: '关闭窗口到托盘', click: () => hideToTray() },
        { type: 'separator' },
        { label: '退出', click: () => opts.onQuit() },
      ]),
    )
    // Windows fires click then double-click; delay single-click toggle and
    // cancel it on double-click so rapid clicks don't destroy+recreate thrash.
    t.on('double-click', () => {
      clearClickTimer()
      showMain()
    })
    t.on('click', () => {
      if (process.platform === 'darwin') return
      clearClickTimer()
      clickTimer = setTimeout(() => {
        clickTimer = null
        const win = opts.getMainWindow()
        if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) hideToTray()
        else showMain()
      }, CLICK_DEBOUNCE_MS)
    })
  }

  const setIconVisible = (visible: boolean) => {
    if (visible) {
      if (tray) return
      tray = new Tray(loadTrayIcon())
      bindTray(tray)
      return
    }
    clearClickTimer()
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
