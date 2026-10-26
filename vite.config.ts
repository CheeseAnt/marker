/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cross-origin isolation enables multi-threaded WASM for on-device speech models.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  server: { headers: isolationHeaders },
  // Pre-bundled up front, so the first use of voice doesn't make the dev server reload the page.
  optimizeDeps: { include: ['@huggingface/transformers'] },
  // The speech worker uses dynamic imports, which only ES module workers support.
  worker: { format: 'es' },
  preview: { headers: isolationHeaders },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Excalidraw's ESM build uses extensionless deep imports; let Vite resolve them.
    server: { deps: { inline: ['@excalidraw/excalidraw'] } },
  },
})
