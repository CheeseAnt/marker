import { useCallback, useEffect, useState } from 'react'
import { useBoard } from '../state/board'
import { startPersistence } from '../state/persist'
import { BoardCanvas } from './BoardCanvas'
import { Drawer } from './Drawer'
import type { DrawerView } from './drawerViews'
import { PromptBar } from './PromptBar'
import { SettingsDialog } from './SettingsDialog'
import { ToastSlot } from './Toast'
import { SaveTemplateDialog } from './SaveTemplateDialog'
import { canvasSelection } from '../state/canvasBridge'
import { useToast } from '../state/toast'
import { useLibrary } from '../templates/library'
import type { Id } from '../model/types'
import { StatusBar } from './StatusBar'

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerView | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The selection is captured when the dialog opens, since using the dialog can't change it.
  const [templateSelection, setTemplateSelection] = useState<Id[] | null>(null)
  const saveSelection = () => {
    const selection = canvasSelection()
    if (selection.length) setTemplateSelection(selection)
    else useToast.getState().show({ kind: 'error', text: 'Select the shapes to save as a template first.' })
  }

  useEffect(() => {
    void useLibrary.getState().load()
  }, [])
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

  // Undo and redo go through BoardBot's history, not Excalidraw's (plan §2).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const isUndo = key === 'z' && !e.shiftKey
      const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey)
      if (!isUndo && !isRedo) return
      // Text fields (including the canvas's own text editor) keep their native undo.
      if ((e.target as HTMLElement | null)?.matches('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      try {
        if (isUndo) useBoard.getState().undo()
        else useBoard.getState().redo()
      } catch (err) {
        onError(`Could not ${isUndo ? 'undo' : 'redo'}: ${(err as Error).message}`)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onError])

  return (
    <div className="app">
      <main className="canvas">
        {loaded && <BoardCanvas onError={onError} />}
        <ToastSlot />
      </main>
      {drawer && <Drawer view={drawer} onSaveSelection={saveSelection} />}
      <PromptBar onOpenSettings={() => setSettingsOpen(true)} />
      <StatusBar
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        drawer={drawer}
        onToggleDrawer={(view) => setDrawer((current) => (current === view ? null : view))}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SaveTemplateDialog open={templateSelection !== null} selection={templateSelection ?? []} onClose={() => setTemplateSelection(null)} />
    </div>
  )
}
