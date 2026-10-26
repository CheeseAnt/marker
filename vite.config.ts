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

/**
 * The content security policy for built pages: only this app's own code runs, and it only talks to
 * Azure (models) and Hugging Face (speech model downloads). The dev server needs inline scripts for
 * hot reload, so it goes without.
 */
const CSP = [
  "default-src 'self'",
  // WASM compilation and blob: modules are how ONNX Runtime starts in the speech worker.
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob: https://*.openai.azure.com https://*.services.ai.azure.com https://*.cognitiveservices.azure.com https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  // Excalidraw and React position things with inline styles.
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

/**
 * Excalidraw lists a CDN (esm.sh) as the second source of every font face. Our fonts are served
 * locally, but under the content security policy Chrome still tries, and is refused, the CDN for
 * every face. This points that fallback at this app instead, so the build never contacts a CDN.
 */
function excalidrawFontFallback(): Plugin {
  // The URL is a template literal with another template nested inside it, so match lazily up to its end.
  const FALLBACK = /`https:\/\/esm\.sh\/\$\{.*?\}\/dist\/prod\/`/s
  return {
    name: 'boardbot-excalidraw-font-fallback',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw') || !FALLBACK.test(code)) return undefined
      return { code: code.replace(FALLBACK, '`${location.origin}/`'), map: null }
    },
  }
}

function contentSecurityPolicy(): Plugin {
  return {
    name: 'boardbot-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

export default defineConfig({
  plugins: [react(), ortRuntime(), contentSecurityPolicy(), excalidrawFontFallback()],
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
