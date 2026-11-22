// `process` is imported rather than taken as a global: this file runs in Node, but the lint config declares browser
// globals only — deliberately, so that browser code referencing `process` is still caught as the mistake it is.
import process from 'node:process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    // Without this, every dynamic import is inlined into one bundle, so three.js (only ever used by the public
    // landing page) would be downloaded by the application too. Splitting keeps it in its own lazy chunk.
    build: { rolldownOptions: { output: { codeSplitting: true } } },
    server: {
      port: 5173,
      strictPort: true, // the API only allows the configured origin, so never drift to another port
      proxy: { '/api': env.VITE_DEV_API_TARGET || 'http://localhost:4000' },
    },
  }
})
