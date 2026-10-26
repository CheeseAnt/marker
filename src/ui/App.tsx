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
import { useUsage } from '../usage/ledger'
import { saveBoard, useFile } from '../state/file'
import { UnsavedDialog } from './UnsavedDialog'
import { openBoardAfterSaving } from '../state/unsaved'
import type { Id } from '../model/types'
import { StatusBar } from './StatusBar'
import { useTheme } from './theme'

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<DrawerView | null>(null)
  // The whole interface follows the theme, whether or not the canvas has loaded.
  useTheme()
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
    void useUsage.getState().load()
    void useFile.getState().load()
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

  // Undo and redo go through Marker's history, not Excalidraw's (plan §2).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      // Saving and opening work everywhere, and take over the browser's (and Excalidraw's) own.
      if ((key === 's' || key === 'o') && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (key === 's') void saveBoard({ as: e.shiftKey })
        else if (!e.shiftKey) void openBoardAfterSaving()
        return
      }
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
      {drawer && <Drawer view={drawer} onSaveSelection={saveSelection} onOpenSettings={() => setSettingsOpen(true)} />}
      <PromptBar onOpenSettings={() => setSettingsOpen(true)} />
      <StatusBar
        notice={notice}
        onDismissNotice={() => setNotice(null)}
        drawer={drawer}
        onToggleDrawer={(view) => setDrawer((current) => (current === view ? null : view))}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <UnsavedDialog />
      <SaveTemplateDialog open={templateSelection !== null} selection={templateSelection ?? []} onClose={() => setTemplateSelection(null)} />
    </div>
  )
}
