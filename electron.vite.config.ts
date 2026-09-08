import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {
    build: {
      // The renderer runs sandboxed, and a sandboxed preload can only require
      // 'electron' plus a few Node builtins, so third-party deps
      // (@electron-toolkit/preload) must be bundled into the preload file
      // rather than left as require() calls.
      externalizeDeps: false
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
