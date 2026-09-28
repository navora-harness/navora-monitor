/// <reference types="vite/client" />

import type { NavoraMonitorApi } from '@shared/ipc-types'

declare const __NM_UI_VERSION__: string

declare global {
  interface Window {
    navoraMonitor: NavoraMonitorApi
  }
}

export {}
