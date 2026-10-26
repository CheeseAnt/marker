import { useCallback, useEffect, useMemo, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { debounce, loadScene, saveScene } from '../storage/idb'
import { PromptBar } from './PromptBar'
import { StatusBar } from './StatusBar'

export default function App() {
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null)

  useEffect(() => {
    loadScene().then((stored) => {
      setInitialData({
        elements: (stored?.elements ?? []) as ExcalidrawInitialDataState['elements'],
      })
    })
  }, [])

  // Undo/redo belongs to BoardBot's history (plan §2), so Excalidraw's shortcuts are swallowed.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  const autosave = useMemo(() => debounce(saveScene, 500), [])
  const onChange = useCallback(
    (elements: readonly unknown[]) => autosave(elements),
    [autosave],
  )

  return (
    <div className="app">
      <div className="canvas">
        {initialData && <Excalidraw initialData={initialData} onChange={onChange} />}
      </div>
      <PromptBar />
      <StatusBar />
    </div>
  )
}
