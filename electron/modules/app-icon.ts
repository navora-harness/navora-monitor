import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'

declare const __dirname: string

/** Resolve packaged / dev paths for window & tray icons (no white-edge teal glyph). */
export function resolveIconPath(names: string[]): string | null {
  const bases = [
    join(__dirname, 'assets'),
    join(__dirname, '..', 'electron', 'assets'),
    join(process.cwd(), 'electron', 'assets'),
    join(process.cwd(), 'dist-electron', 'assets'),
  ]
  for (const base of bases) {
    for (const name of names) {
      const file = join(base, name)
      if (existsSync(file)) return file
    }
  }
  return null
}

export function loadAppIcon(): NativeImage | null {
  const file = resolveIconPath(['icon.png', 'tray-icon.png'])
  if (!file) return null
  const img = nativeImage.createFromPath(file)
  return img.isEmpty() ? null : img
}

export function loadTrayIcon(): NativeImage {
  const file = resolveIconPath(['tray-icon.png', 'tray-icon-16.png', 'icon.png'])
  if (file) {
    let img = nativeImage.createFromPath(file)
    if (!img.isEmpty()) {
      const { width } = img.getSize()
      if (width > 32) img = img.resize({ width: 16, height: 16, quality: 'best' })
      return img
    }
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVQ4T2NkoBAwUqifgYGB4T8DwwEGBgYGRgr1jzIw/Gdg+M9AqX4GBgYGABfKBBfJ8mZSAAAAAElFTkSuQmCC',
  )
}
