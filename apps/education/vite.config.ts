import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A plain multi-asset build, unlike ui/ next door: this one is served over HTTP
// to a Chromebook and installed as a PWA, so the service worker and the
// manifest have to be real files with their own URLs.
const apiTarget = process.env.DEMO_API ?? 'http://127.0.0.1:4600'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    fs: {
      // contracts/learning-event.schema.json lives at the repo root: one copy of
      // the contract for the app, the demo API and the tests.
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome111', sourcemap: false },
})
