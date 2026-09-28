import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'nm-ui-version',
      transformIndexHtml(html) {
        return html.replaceAll('%NM_UI_VERSION%', pkg.version)
      },
    },
  ],
  base: './',
  define: {
    __NM_UI_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    watch: {
      ignored: ['**/release/**', '**/vendor/**', '**/portable/**', '**/_recycle/**'],
    },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8780', changeOrigin: true, ws: true },
      '/media': { target: 'http://127.0.0.1:8780', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/_recycle/**'],
  },
})
