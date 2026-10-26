import { useCallback, useEffect, useMemo, useRef } from 'react'
import { CaptureUpdateAction, Excalidraw, Footer, hashElementsVersion, restoreElements } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { diffScene } from '../compile/fromExcalidraw'
import type { ExElement } from '../compile/exTypes'
import { OpError } from '../model/apply'
import { setPendingEditsFlusher, useBoard } from '../state/board'
import { debounce } from '../storage/idb'

/** True while the user is mid-gesture; syncing then would fight Excalidraw's own state. */
function isInteracting(s: AppState): boolean {
  return Boolean(
    s.cursorButton === 'down' ||
      s.newElement ||
      s.editingTextElement ||
      s.multiElement ||
      s.resizingElement ||
      s.editingLinearElement ||
      s.isResizing ||
      s.isRotating ||
      s.selectedElementsAreBeingDragged,
  )
}

interface Props {
  onError: (message: string) => void
}

/**
 * Two-way bridge between the board and Excalidraw. Board changes are rendered into the scene;
 * edits made in the scene are diffed back into ops once the user's gesture is finished.
 */
export function BoardCanvas({ onError }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  // Version hash of the scene we last rendered or read, so our own updates are not re-read.
  const seenVersion = useRef<number | null>(null)
  const renderPending = useRef(false)
  const revision = useBoard((s) => s.revision)

  const render = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    if (isInteracting(api.getAppState())) {
      renderPending.current = true
      return
    }
    renderPending.current = false
    const current = api.getSceneElementsIncludingDeleted()
    const compiled = useBoard.getState().compiled.elements as unknown as ExcalidrawElement[]
    const elements = restoreElements(compiled, current, { refreshDimensions: true, repairBindings: true })
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
    seenVersion.current = hashElementsVersion(api.getSceneElementsIncludingDeleted())
  }, [])

  const readScene = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const scene = api.getSceneElementsIncludingDeleted()
    // Excalidraw loads `initialData` asynchronously; the first scene it reports is our baseline.
    if (seenVersion.current === null) {
      seenVersion.current = hashElementsVersion(scene)
      return
    }
    if (isInteracting(api.getAppState())) return
    if (renderPending.current) return render()
    const version = hashElementsVersion(scene)
    if (version === seenVersion.current) return
    seenVersion.current = version
    const { board, compiled, apply } = useBoard.getState()
    try {
      const ops = diffScene({ board, compiled, scene: scene as unknown as ExElement[] })
      if (ops.length) apply(ops, 'manual')
    } catch (e) {
      onError(e instanceof OpError ? `Could not record that edit: ${e.issues[0]}` : String(e))
      render()
    }
  }, [onError, render])

  const readSoon = useMemo(() => debounce(readScene, 250), [readScene])

  // Undo must see edits that are still waiting for the debounce.
  useEffect(() => {
    setPendingEditsFlusher(readScene)
    return () => setPendingEditsFlusher(() => {})
  }, [readScene])

  // Re-render whenever the board changes, including after our own manual-edit ops, so derived
  // geometry (relative placement, arrow routing, re-keyed ids) is shown as the board has it.
  const firstRevision = useRef(revision)
  useEffect(() => {
    if (revision !== firstRevision.current) render()
  }, [revision, render])

  // Excalidraw only listens to window resizes; the drawer resizes the canvas without one.
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => apiRef.current?.refresh())
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const initialData = useMemo(() => {
    const compiled = useBoard.getState().compiled.elements as unknown as ExcalidrawElement[]
    return { elements: restoreElements(compiled, null, { refreshDimensions: true, repairBindings: true }) }
  }, [])

  return (
    <div ref={hostRef} className="canvas-host">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api
        }}
        onChange={() => readSoon()}
        onPointerUp={() => setTimeout(readScene, 0)}
      >
        <Footer>
          <HistoryButtons />
        </Footer>
      </Excalidraw>
    </div>
  )
}

function UndoIcon({ flip = false }: { flip?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  )
}

/** Undo and redo in the spot where Excalidraw's own (hidden) buttons were. */
function HistoryButtons() {
  const canUndo = useBoard((s) => s.history.past.length > 0)
  const canRedo = useBoard((s) => s.history.future.length > 0)
  const undo = useBoard((s) => s.undo)
  const redo = useBoard((s) => s.redo)
  return (
    <div className="history-buttons">
      <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <UndoIcon />
      </button>
      <button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <UndoIcon flip />
      </button>
    </div>
  )
}
