/// <reference types="vitest/config" />
import { createReadStream, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Cross-origin isolation enables multi-threaded WASM for on-device speech models.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

const ORT_DIST = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url))

const ORT_PATHS = 'virtual:ort-paths'
const ORT_FILE = 'ort-wasm-simd-threaded.asyncify'

/**
 * Where the speech worker loads ONNX Runtime from (`import ortPaths from 'virtual:ort-paths'`).
 * In development the files are served untouched at /ort/, as plain static files. A build imports
 * them by URL, which reuses the copy Vite already emits for ONNX Runtime itself, so there is one.
 * The URL imports exist only in builds, where the dev dependency optimiser never sees them.
 */
function ortRuntime(): Plugin {
  let serving = false
  return {
    name: 'boardbot-ort-runtime',
    configResolved(config) {
      serving = config.command === 'serve'
    },
    resolveId(id) {
      return id === ORT_PATHS ? `\0${ORT_PATHS}` : undefined
    },
    load(id) {
      if (id !== `\0${ORT_PATHS}`) return undefined
      if (serving) return `export default { mjs: '/ort/${ORT_FILE}.mjs', wasm: '/ort/${ORT_FILE}.wasm' }`
      return [
        `import mjs from '${ORT_DIST}${ORT_FILE}.mjs?url'`,
        `import wasm from '${ORT_DIST}${ORT_FILE}.wasm?url'`,
        'export default { mjs, wasm }',
      ].join('\n')
    },
    configureServer(server) {
      server.middlewares.use('/ort/', (req, res, next) => {
        const file = (req.url ?? '').split('?')[0].replace(/^\/+/, '')
        const path = ORT_DIST + file
        if (!/^ort-wasm-simd-threaded[\w.]*\.(mjs|wasm)$/.test(file) || !existsSync(path)) return next()
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(path).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), ortRuntime()],
  server: { headers: isolationHeaders },
  // Pre-bundled up front, so the first use of voice doesn't make the dev server reload the page.
  optimizeDeps: { include: ['@huggingface/transformers'] },
  // The speech worker uses dynamic imports, which only ES module workers support.
  worker: { format: 'es', plugins: () => [ortRuntime()] },
  preview: { headers: isolationHeaders },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Excalidraw's ESM build uses extensionless deep imports; let Vite resolve them.
    server: { deps: { inline: ['@excalidraw/excalidraw'] } },
  },
})
