/// <reference types="vite/client" />

declare module 'virtual:ort-paths' {
  /** URLs of ONNX Runtime's loader and WASM binary, from this app (see vite.config.ts). */
  const paths: { mjs: string; wasm: string }
  export default paths
}
