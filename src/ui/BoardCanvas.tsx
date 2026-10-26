import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw, Footer, hashElementsVersion, MainMenu, restoreElements } from '@excalidraw/excalidraw'
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { diffSceneDetailed } from '../compile/fromExcalidraw'
import { imageSize } from '../assets/image'
import { cachedAsset, loadAsset, saveAsset } from '../assets/store'
import { detachOps } from '../templates/detach'
import { useToast } from '../state/toast'
import { useJobs } from '../jobs/queue'
import { isGeneratedId, shortIdOps } from '../model/shortIds'
import type { ExElement } from '../compile/exTypes'
import { OpError } from '../model/apply'
import { DEFAULT_FONT, FONT_PRESETS, fontPreset, withBoardFont, type FontId } from '../model/fonts'
import { setPendingEditsFlusher, useBoard } from '../state/board'
import { registerCanvas } from '../state/canvasBridge'
import { saveBoard } from '../state/file'
import { newBoardAfterSaving, openBoardAfterSaving } from '../state/unsaved'
import { LABEL_SUFFIX } from '../compile/exTypes'
import { debounce } from '../storage/idb'
import { followersOf, unionBoxes, type Box } from '../model/geometry'
import type { Id } from '../model/types'
import { CanvasOverlay, type FollowLink } from './CanvasOverlay'
import { toScreen, type View } from './canvasView'
import { THEME_LABELS, useTheme } from './theme'
import { useSettings } from '../settings/store'

const HIGHLIGHT_MS = 1600
/** How long the canvas must be quiet before hand-drawn elements get short ids. */
const RENAME_IDLE_MS = 2000

/** Excalidraw ids that belong to a renamed board element: itself, its label, its parts. */
function renamedExId(exId: string, renamed: Map<string, string>): string {
  for (const [from, to] of renamed) {
    if (exId === from) return to
    if (exId.startsWith(from) && ['~', '/'].includes(exId[from.length])) return to + exId.slice(from.length)
  }
  return exId
}

function renameKeys(record: Readonly<Record<string, boolean>>, renamed: Map<string, string>): Record<string, true> {
  return Object.fromEntries(Object.keys(record).filter((k) => record[k]).map((k) => [renamedExId(k, renamed), true]))
}

/** Gives Excalidraw the bytes of any board image it doesn't have yet. */
async function loadImages(api: ExcalidrawImperativeAPI) {
  const have = api.getFiles()
  const wanted = new Set(
    api
      .getSceneElements()
      .flatMap((e) => (e.type === 'image' && e.fileId && !have[e.fileId] ? [e.fileId] : [])),
  )
  const found = (await Promise.all([...wanted].map(loadAsset))).filter((a) => a !== undefined)
  if (found.length) {
    api.addFiles(found.map((a) => ({ id: a.id as never, dataURL: a.dataURL as never, mimeType: a.mimeType as never, created: a.created })))
  }
}

/** Keeps the bytes of images pasted or dropped onto the canvas, so the board can show them again. */
async function storeImages(api: ExcalidrawImperativeAPI) {
  for (const file of Object.values(api.getFiles())) {
    if (cachedAsset(file.id)) continue
    const { width, height } = await imageSize(file.dataURL).catch(() => ({ width: 0, height: 0 }))
    await saveAsset({ id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, width, height, created: file.created })
  }
}

/** Scene-space bounds of an element, including arrow and freehand points. */
function sceneBox(e: ExcalidrawElement): Box {
  if ('points' in e && e.points.length) {
    const xs = e.points.map((p) => p[0] + e.x)
    const ys = e.points.map((p) => p[1] + e.y)
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  return { x: e.x, y: e.y, w: e.width, h: e.height }
}

function viewOf(s: AppState): View {
  return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }
}

/** Board ids of what's selected on the canvas (labels count as their owner). */
function selectedBoardIds(s: AppState): Id[] {
  const ids = new Set(useBoard.getState().board.elements.map((e) => e.id))
  const picked = [
    ...Object.keys(s.selectedElementIds).filter((id) => s.selectedElementIds[id]),
    ...Object.keys(s.selectedGroupIds ?? {}).filter((id) => s.selectedGroupIds[id]),
  ].map((id) => (id.endsWith(LABEL_SUFFIX) ? id.slice(0, -LABEL_SUFFIX.length) : id))
  return [...new Set(picked)].filter((id) => ids.has(id))
}

/**
 * While elements are dragged, links from each to what is placed relative to it, which will
 * follow it once it's dropped. The dragged ends use where the elements are right now.
 */
function followLinks(scene: readonly ExcalidrawElement[], s: AppState): FollowLink[] {
  const { board, compiled } = useBoard.getState()
  const dragged = new Set(selectedBoardIds(s))
  for (const el of board.elements) if (el.kind === 'group' && dragged.has(el.id)) el.members.forEach((m) => dragged.add(m))
  const pairs = followersOf(board, dragged)
  if (!pairs.length) return []
  const live = (id: Id): Box | undefined => {
    const own = scene.find((e) => e.id === id && !e.isDeleted)
    if (own) return sceneBox(own)
    return unionBoxes(scene.filter((e) => !e.isDeleted && e.groupIds.includes(id)).map(sceneBox))
  }
  return pairs.flatMap(([anchorId, followerId]) => {
    const anchor = dragged.has(anchorId) ? live(anchorId) : compiled.boxes.get(anchorId)
    const follower = compiled.boxes.get(followerId)
    return anchor && follower ? [{ anchor, follower }] : []
  })
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
  // Elements drawn by hand that still have Excalidraw's long ids, and ids just renamed.
  const toShorten = useRef(new Set<string>())
  const justRenamed = useRef<Map<string, string> | null>(null)
  const renameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The board font last pushed to Excalidraw as its font for new text.
  const defaultFamily = useRef(fontPreset(useBoard.getState().board.defaults.font).family)
  const [highlights, setHighlights] = useState<{ key: number; boxes: Box[] } | null>(null)
  const [view, setView] = useState<View>({ scrollX: 0, scrollY: 0, zoom: 1 })
  const [links, setLinks] = useState<FollowLink[]>([])
  const revision = useBoard((s) => s.revision)
  const theme = useTheme()

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
    // Keep the selection on elements that were just given short ids.
    const renamed = justRenamed.current
    justRenamed.current = null
    const before = api.getAppState()
    const selection = renamed && {
      selectedElementIds: renameKeys(before.selectedElementIds, renamed),
      selectedGroupIds: renameKeys(before.selectedGroupIds ?? {}, renamed),
    }
    api.updateScene({
      elements,
      ...((fontChanged || selection) && { appState: { ...(fontChanged && { currentItemFontFamily: family as never }), ...selection } as never }),
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    seenVersion.current = hashElementsVersion(api.getSceneElementsIncludingDeleted())
    void loadImages(api)

    const ids = pendingHighlight.current
    pendingHighlight.current = null
    if (ids?.length) {
      // Labels sit inside their shape, so the shape's ring covers them.
      const targets = elements.filter((e) => !e.isDeleted && ids.includes(e.id))
      const appState = api.getAppState()
      let boxes = targets.map((e) => toScreen(sceneBox(e), viewOf(appState)))
      const visible = boxes.some((b) => b.x + b.w > 0 && b.y + b.h > 0 && b.x < appState.width && b.y < appState.height)
      if (!visible && targets.length) {
        // Bring off-screen changes into view; the highlight follows once scrolling settles.
        api.scrollToContent(targets, { fitToContent: false, animate: false })
        const moved = api.getAppState()
        boxes = targets.map((e) => toScreen(sceneBox(e), viewOf(moved)))
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
        return api ? selectedBoardIds(api.getAppState()) : []
      },
      highlightAfterRender: (ids) => {
        pendingHighlight.current = ids
      },
      viewportCenter: () => {
        const api = apiRef.current
        if (!api) return { x: 0, y: 0 }
        const { width, height, scrollX, scrollY, zoom } = api.getAppState()
        return { x: width / 2 / zoom.value - scrollX, y: height / 2 / zoom.value - scrollY }
      },
      viewport: () => {
        const api = apiRef.current
        if (!api) return { x: 0, y: 0, w: 0, h: 0 }
        const { width, height, scrollX, scrollY, zoom } = api.getAppState()
        return { x: -scrollX, y: -scrollY, w: width / zoom.value, h: height / zoom.value }
      },
    })
    return () => registerCanvas(null)
  }, [])

  /**
   * Gives hand-drawn elements short ids (rect1, arrow2) once the canvas has been quiet for a
   * moment. The renames join the user's newest change, so undoing it undoes them too.
   */
  const shortenIds = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const typing = document.activeElement?.matches('textarea, input')
    if (isInteracting(api.getAppState()) || typing) {
      renameTimer.current = setTimeout(shortenIds, RENAME_IDLE_MS)
      return
    }
    const { board, history, amend } = useBoard.getState()
    // Only fold the renames into the user's own canvas edit; otherwise wait for the next one.
    if (history.past.at(-1)?.source !== 'manual') return
    const ops = shortIdOps(board, toShorten.current)
    toShorten.current.clear()
    if (!ops.length) return
    const renamed = new Map(ops.flatMap((o) => (o.op === 'rename' ? [[o.from, o.to] as const] : [])))
    justRenamed.current = renamed
    if (amend(ops)) useJobs.getState().renameIds(renamed)
    else justRenamed.current = null
  }, [])

  const scheduleShortIds = useCallback(() => {
    clearTimeout(renameTimer.current)
    renameTimer.current = setTimeout(shortenIds, RENAME_IDLE_MS)
  }, [shortenIds])

  useEffect(() => () => clearTimeout(renameTimer.current), [])

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
    void storeImages(api)
    const { board, compiled, apply } = useBoard.getState()
    try {
      const { ops, rejected } = diffSceneDetailed({ board, compiled, scene: scene as unknown as ExElement[] })
      if (ops.length) {
        apply(ops, 'manual')
        for (const op of ops) if (op.op === 'add' && isGeneratedId(op.element.id)) toShorten.current.add(op.element.id)
        if (toShorten.current.size) scheduleShortIds()
      }
      if (rejected.length) {
        // Parts of a template copy move together; put them back and offer to detach the copy.
        if (!ops.length) render()
        const id = rejected[0]
        useToast.getState().show({
          kind: 'error',
          text: `The parts of “${id}” move together because it's a copy of a template. Detach it to edit its parts on their own.`,
          action: {
            label: 'Detach',
            run: () => {
              const current = useBoard.getState().board
              useBoard.getState().apply(detachOps(current, id, { keepGrouped: true }), 'manual', { title: `Detached “${id}” from its template` })
            },
          },
        })
      }
    } catch (e) {
      onError(e instanceof OpError ? `Could not record that edit: ${e.issues[0]}` : String(e))
      render()
    }
  }, [onError, render, scheduleShortIds])

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
        theme={theme}
        excalidrawAPI={(api) => {
          apiRef.current = api
          setView(viewOf(api.getAppState()))
          void loadImages(api)
          // Lets end-to-end tests check which image files the canvas has.
          if (import.meta.env.DEV) Object.assign(window, { __markerFiles: () => Object.keys(api.getFiles()) })
          // Text is measured when rendered; a font that arrives later would leave it clipped.
          // Load every preset face, then render again so all text is measured in its real font.
          Promise.all(FONT_PRESETS.map((f) => document.fonts.load(`20px "${f.css}"`)))
            .catch(() => undefined)
            .then(() => {
              forceRender.current = true
              render()
            })
        }}
        onChange={(scene, appState) => {
          readSoon()
          // Excalidraw calls onChange after every render, so state only changes when it differs.
          const next = appState.selectedElementsAreBeingDragged ? followLinks(scene, appState) : []
          setLinks((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
        }}
        onScrollChange={(scrollX, scrollY, zoom) =>
          setView((v) => (v.scrollX === scrollX && v.scrollY === scrollY && v.zoom === zoom.value ? v : { scrollX, scrollY, zoom: zoom.value }))
        }
        onPointerUp={() => setTimeout(readScene, 0)}
        // Lets Virgil and Cascadia be picked per element, matching the board font presets.
        showDeprecatedFonts
      >
        <BoardMenu />
        <Footer>
          <HistoryButtons />
        </Footer>
      </Excalidraw>
      <CanvasOverlay view={view} links={links} />
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

/** Light, dark, or whatever the system uses; it changes the interface, not the board. */
function ThemeMenu() {
  const current = useSettings((s) => s.settings.theme)
  return (
    <MainMenu.Group title="Theme">
      {(Object.keys(THEME_LABELS) as (keyof typeof THEME_LABELS)[]).map((t) => (
        <MainMenu.Item
          key={t}
          selected={current === t}
          icon={current === t ? <CheckIcon /> : <span />}
          onSelect={() => useSettings.getState().update((s) => ({ ...s, theme: t }))}
        >
          {THEME_LABELS[t]}
        </MainMenu.Item>
      ))}
    </MainMenu.Group>
  )
}

/** Excalidraw's main menu, with the board font presets each shown in their own typeface. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl'

function BoardMenu() {
  const current = useBoard((s) => s.board.defaults.font ?? DEFAULT_FONT)
  return (
    <MainMenu>
      <MainMenu.Item onSelect={() => void newBoardAfterSaving()}>New board</MainMenu.Item>
      <MainMenu.Item shortcut={`${MOD}+O`} onSelect={() => void openBoardAfterSaving()}>
        Open…
      </MainMenu.Item>
      <MainMenu.Item shortcut={`${MOD}+S`} onSelect={() => void saveBoard()}>
        Save
      </MainMenu.Item>
      <MainMenu.Item shortcut={`${MOD}+Shift+S`} onSelect={() => void saveBoard({ as: true })}>
        Save as…
      </MainMenu.Item>
      <MainMenu.Separator />
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
      <ThemeMenu />
      <MainMenu.Separator />
      <MainMenu.DefaultItems.SaveAsImage />
      <MainMenu.DefaultItems.ClearCanvas />
      <MainMenu.DefaultItems.Help />
    </MainMenu>
  )
}
