/// <reference types="vite/client" />

import type { NavoraMonitorApi } from '@shared/ipc-types'

declare global {
  interface Window {
    navoraMonitor: NavoraMonitorApi
  }
}

export {}
