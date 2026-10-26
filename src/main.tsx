import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import '@fontsource/atkinson-hyperlegible/latin-400.css'
import '@fontsource/atkinson-hyperlegible/latin-700.css'
import './index.css'
import App from './ui/App.tsx'
import { useBoard } from './state/board'

// Lets end-to-end tests read the board without poking at canvas pixels.
if (import.meta.env.DEV) Object.assign(window, { __boardbot: { useBoard } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
