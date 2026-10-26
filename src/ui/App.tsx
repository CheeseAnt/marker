import { useCallback, useEffect, useState } from 'react'
import { startPersistence } from '../state/persist'
import { BoardCanvas } from './BoardCanvas'
import { BoardTextPanel } from './BoardTextPanel'
import { PromptBar } from './PromptBar'
import { StatusBar } from './StatusBar'

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showText, setShowText] = useState(false)
  const onError = useCallback((message: string) => setNotice(message), [])

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    startPersistence(onError).then((unsubscribe) => {
      if (cancelled) unsubscribe()
      else stop = unsubscribe
      setLoaded(true)
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [onError])

  // Undo/redo belongs to BoardBot's history (plan §2), so Excalidraw's shortcuts are swallowed.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const target = e.target as HTMLElement | null
      // Text fields outside the canvas keep their native undo.
      const ownField = target?.matches('input, textarea') && !target.closest('.excalidraw')
      if ((e.metaKey || e.ctrlKey) && (key === 'z' || key === 'y') && !ownField) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div className="app">
      <main className="canvas">
        {loaded && (
          <BoardCanvas onError={onError} />
        )}
      </main>
      {showText && <BoardTextPanel />}
      <PromptBar />
      <StatusBar
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        showText={showText}
        onToggleText={() => setShowText((v) => !v)}
      />
    </div>
  )
}
