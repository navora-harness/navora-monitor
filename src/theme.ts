/** Theme helpers for light / dark / system */

export type UiTheme = 'light' | 'dark' | 'system'

export function resolveUiTheme(theme: UiTheme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark'
    }
    return 'light'
  }
  return theme
}

export function applyUiTheme(theme: UiTheme) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', resolveUiTheme(theme))
}

export function sanitizeUiTheme(raw: unknown): UiTheme {
  if (raw === 'dark' || raw === 'system' || raw === 'light') return raw
  return 'system'
}
