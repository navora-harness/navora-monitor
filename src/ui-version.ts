/** Build-time UI version (injected by Vite `define`). */
declare const __NM_UI_VERSION__: string

export const NM_UI_VERSION: string =
  typeof __NM_UI_VERSION__ === 'string' ? __NM_UI_VERSION__ : ''
