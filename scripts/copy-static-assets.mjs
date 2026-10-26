// Self-hosts Excalidraw's fonts, which it would otherwise load from a CDN, so they load under
// COOP/COEP and the app works offline. (ONNX Runtime's files are handled in vite.config.ts.)
import { cpSync } from 'node:fs'

cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/fonts', { recursive: true })
