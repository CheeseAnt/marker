// Self-hosts runtime files that would otherwise come from CDNs, so they load under
// COOP/COEP and the app works offline: Excalidraw's fonts and ONNX Runtime's WASM build
// (used by on-device speech recognition).
import { cpSync, mkdirSync } from 'node:fs'

cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/fonts', { recursive: true })

mkdirSync('public/ort', { recursive: true })
for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${file}`, `public/ort/${file}`)
}
