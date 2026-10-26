import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw, Footer, hashElementsVersion, MainMenu, restoreElements } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { diffScene } from '../compile/fromExcalidraw'
import type { ExElement } from '../compile/exTypes'
import { OpError } from '../model/apply'
import { DEFAULT_FONT, FONT_PRESETS, fontPreset, withBoardFont, type FontId } from '../model/fonts'
import { setPendingEditsFlusher, useBoard } from '../state/board'
import { registerCanvas } from '../state/canvasBridge'
import { LABEL_SUFFIX } from '../compile/exTypes'
import { debounce } from '../storage/idb'

const HIGHLIGHT_MS = 1600

interface HighlightBox {
  x: number
  y: number
  w: number
  h: number
}

/** Scene-space bounds of an element, including arrow and freehand points. */
function sceneBox(e: ExcalidrawElement): HighlightBox {
  if ('points' in e && e.points.length) {
    const xs = e.points.map((p) => p[0] + e.x)
    const ys = e.points.map((p) => p[1] + e.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height }
}

function toScreen(b: HighlightBox, s: AppState): HighlightBox {
  const z = s.zoom.value
  return { x: (b.x + s.scrollX) * z, y: (b.y + s.scrollY) * z, w: b.w * z, h: b.h * z }
}

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
  // Set when text must be re-measured even though the board itself did not change.
  const forceRender = useRef(false)
  const pendingHighlight = useRef<string[] | null>(null)
  // The board font last pushed to Excalidraw as its font for new text.
  const defaultFamily = useRef(fontPreset(useBoard.getState().board.defaults.font).family)
  const [highlights, setHighlights] = useState<{ key: number; boxes: HighlightBox[] } | null>(null)
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
    // Re-measuring creates new element versions, which Excalidraw only repaints when told to.
    const elements = restoreElements(compiled, forceRender.current ? null : current, { refreshDimensions: true, repairBindings: true })
    forceRender.current = false
    // New text drawn by hand should start in the board font, so follow it when it changes.
    const family = fontPreset(useBoard.getState().board.defaults.font).family
    const fontChanged = family !== defaultFamily.current
    defaultFamily.current = family
    api.updateScene({
      elements,
      ...(fontChanged && { appState: { currentItemFontFamily: family as never } }),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    seenVersion.current = hashElementsVersion(api.getSceneElementsIncludingDeleted())

    const ids = pendingHighlight.current
    pendingHighlight.current = null
    if (ids?.length) {
      // Labels sit inside their shape, so the shape's ring covers them.
      const targets = elements.filter((e) => !e.isDeleted && ids.includes(e.id))
      const appState = api.getAppState()
      let boxes = targets.map((e) => toScreen(sceneBox(e), appState))
      const visible = boxes.some((b) => b.x + b.w > 0 && b.y + b.h > 0 && b.x < appState.width && b.y < appState.height)
      if (!visible && targets.length) {
        // Bring off-screen changes into view; the highlight follows once scrolling settles.
        api.scrollToContent(targets, { fitToContent: false, animate: false })
        const moved = api.getAppState()
        boxes = targets.map((e) => toScreen(sceneBox(e), moved))
      }
      setHighlights({ key: Date.now(), boxes })
    }
  }, [])

  // Highlights fade on their own; clear them once the animation has finished.
  useEffect(() => {
    if (!highlights) return
    const timer = setTimeout(() => setHighlights(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlights])

  useEffect(() => {
    registerCanvas({
      selection: () => {
        const api = apiRef.current
        if (!api) return []
        const { selectedElementIds, selectedGroupIds } = api.getAppState()
        const board = useBoard.getState().board
        const ids = new Set(board.elements.map((e) => e.id))
        const picked = [
          ...Object.keys(selectedElementIds).filter((id) => selectedElementIds[id]),
          ...Object.keys(selectedGroupIds ?? {}).filter((id) => selectedGroupIds[id]),
        ].map((id) => (id.endsWith(LABEL_SUFFIX) ? id.slice(0, -LABEL_SUFFIX.length) : id))
        return [...new Set(picked)].filter((id) => ids.has(id))
      },
      highlightAfterRender: (ids) => {
        pendingHighlight.current = ids
      },
    })
    return () => registerCanvas(null)
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
    return {
      elements: restoreElements(compiled, null, { refreshDimensions: true, repairBindings: true }),
      appState: { currentItemFontFamily: defaultFamily.current as never },
    }
  }, [])

  return (
    <div ref={hostRef} className="canvas-host">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api
          // Text is measured when rendered; a font that arrives later would leave it clipped.
          // Load every preset face, then render again so all text is measured in its real font.
          Promise.all(FONT_PRESETS.map((f) => document.fonts.load(`20px "${f.css}"`)))
            .catch(() => undefined)
            .then(() => {
              forceRender.current = true
              render()
            })
        }}
        onChange={() => readSoon()}
        onPointerUp={() => setTimeout(readScene, 0)}
        // Lets Virgil and Cascadia be picked per element, matching the board font presets.
        showDeprecatedFonts
      >
        <BoardMenu />
        <Footer>
          <HistoryButtons />
        </Footer>
      </Excalidraw>
      {highlights && (
        <div className="change-highlights" key={highlights.key} aria-hidden="true">
          {highlights.boxes.map((b, i) => (
            <span key={i} className="change-highlight" style={{ left: b.x - 8, top: b.y - 8, width: b.w + 16, height: b.h + 16 }} />
          ))}
        </div>
      )}
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

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5 9-10" />
    </svg>
  )
}

function setBoardFont(font: FontId) {
  const { board, apply } = useBoard.getState()
  if ((board.defaults.font ?? DEFAULT_FONT) === font) return
  apply([{ op: 'board', set: { defaults: withBoardFont(board.defaults, font) } }], 'manual', { title: `Changed the board font to ${fontPreset(font).label}` })
}

/** Excalidraw's main menu, with the board font presets each shown in their own typeface. */
function BoardMenu() {
  const current = useBoard((s) => s.board.defaults.font ?? DEFAULT_FONT)
  return (
    <MainMenu>
      <MainMenu.Group title="Board font">
        {FONT_PRESETS.map((f) => (
          <MainMenu.Item
            key={f.id}
            selected={current === f.id}
            icon={current === f.id ? <CheckIcon /> : <span />}
            textStyle={{ fontFamily: `"${f.css}", var(--font-ui)`, fontSize: '1rem' }}
            title={`${f.label}: ${f.note}`}
            onSelect={() => setBoardFont(f.id)}
          >
            {f.label}
          </MainMenu.Item>
        ))}
      </MainMenu.Group>
      <MainMenu.Separator />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.DefaultItems.Help />
    </MainMenu>
  )
}
