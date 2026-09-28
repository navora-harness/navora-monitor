/** Third-party projects shown under 开源鸣谢 (About). */

export type OpenSourceCredit = {
  name: string
  url: string
  note?: string
}

/** Runtime and shipped dependencies first; build tools after. */
export const OPEN_SOURCE_CREDITS: OpenSourceCredit[] = [
  { name: 'Vue', url: 'https://github.com/vuejs/core', note: 'MIT' },
  { name: 'hls.js', url: 'https://github.com/video-dev/hls.js', note: 'Apache-2.0' },
  { name: 'mpegts.js', url: 'https://github.com/xqq/mpegts.js', note: 'Apache-2.0' },
  { name: 'FFmpeg', url: 'https://ffmpeg.org/', note: 'LGPL/GPL' },
  {
    name: 'FFmpeg Builds (BtbN)',
    url: 'https://github.com/BtbN/FFmpeg-Builds',
    note: '发行包内置二进制 · GPLv3',
  },
  { name: 'Go', url: 'https://go.dev/', note: 'BSD-3-Clause' },
  { name: 'golang.org/x/crypto', url: 'https://pkg.go.dev/golang.org/x/crypto', note: 'BSD-3-Clause' },
  { name: 'Vite', url: 'https://vitejs.dev/', note: 'MIT' },
  { name: 'TypeScript', url: 'https://www.typescriptlang.org/', note: 'Apache-2.0' },
  { name: 'vue-tsc', url: 'https://github.com/vuejs/language-tools', note: 'MIT' },
  { name: '@vitejs/plugin-vue', url: 'https://github.com/vitejs/vite-plugin-vue', note: 'MIT' },
  { name: 'esbuild', url: 'https://esbuild.github.io/', note: 'MIT' },
  { name: 'Vitest', url: 'https://vitest.dev/', note: 'MIT' },
]
