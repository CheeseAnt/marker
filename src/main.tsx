import './storage/renameOnLoad'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import '@fontsource/atkinson-hyperlegible/latin-400.css'
import '@fontsource/atkinson-hyperlegible/latin-700.css'
import './index.css'
import App from './ui/App.tsx'
import { registerServiceWorker } from './pwa'
import { useBoard } from './state/board'
import { useJobs } from './jobs/queue'
import { useVoice } from './speech/voice'
import { useUsage } from './usage/ledger'
import { migrateIndexedDb } from './storage/migrateName'

// Works offline once loaded (production builds only).
if (import.meta.env.PROD) void registerServiceWorker()

// Lets end-to-end tests read the board without poking at canvas pixels.
if (import.meta.env.DEV) Object.assign(window, { __marker: { useBoard, useJobs, useVoice, useUsage } })

// Saved boards, templates and images move to their new keys before anything reads them.
void migrateIndexedDb().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
