// Self-hosts Excalidraw's fonts so they load under COEP and work offline.
import { cpSync } from 'node:fs'

cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/fonts', { recursive: true })
