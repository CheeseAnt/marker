import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import './index.css'
import App from './ui/App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
