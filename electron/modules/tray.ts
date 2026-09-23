import { Tray, Menu, type BrowserWindow } from 'electron'
import { loadTrayIcon } from './app-icon'

export type TrayController = {
  destroy: () => void
  showMain: () => void
  hideToTray: () => void
}

export function createAppTray(opts: {
  getMainWindow: () => BrowserWindow | null
  onQuit: () => void
}): TrayController {
  const tray = new Tray(loadTrayIcon())
  tray.setToolTip('Navora Monitor')

  const showMain = () => {
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

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Navora Monitor', click: () => showMain() },
      { label: '隐藏到托盘', click: () => hideToTray() },
      { type: 'separator' },
      { label: '退出', click: () => opts.onQuit() },
    ]),
  )
  tray.on('double-click', () => showMain())
  tray.on('click', () => {
    if (process.platform === 'darwin') return
    const win = opts.getMainWindow()
    if (win && !win.isDestroyed() && win.isVisible()) hideToTray()
    else showMain()
  })

  return { destroy: () => tray.destroy(), showMain, hideToTray }
}
