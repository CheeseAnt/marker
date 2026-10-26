import { useEffect, useRef } from 'react'
import { exportToSvg, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { compileBoard } from '../compile/toExcalidraw'
import type { Board, BoardElement } from '../model/types'
import { fillParams } from '../templates/expand'

const cache = new Map<string, string>()

/** A small drawing of a template, rendered once per version and kept. */
export function TemplatePreview({ cacheKey, board }: { cacheKey: string; board: Board }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const show = (svg: string) => {
      if (!cancelled && host.current) host.current.innerHTML = svg
    }
    const cached = cache.get(cacheKey)
    if (cached) return show(cached)
    // Show what a fresh copy looks like: placeholders filled with their defaults.
    const defaults = Object.fromEntries((board.template?.params ?? []).map((p) => [p.name, p.default]))
    const filled = { ...board, elements: board.elements.map((e) => fillElement(e, defaults)) }
    const elements = restoreElements(compileBoard(filled).elements as unknown as ExcalidrawElement[], null, { refreshDimensions: true })
    exportToSvg({ elements, appState: { exportBackground: false }, files: null, exportPadding: 6, skipInliningFonts: true })
      .then((svg: SVGSVGElement) => {
        svg.removeAttribute('width')
        svg.removeAttribute('height')
        const markup = svg.outerHTML
        cache.set(cacheKey, markup)
        show(markup)
      })
      .catch(() => show(''))
    return () => {
      cancelled = true
    }
  }, [cacheKey, board])

  return <div ref={host} className="template-preview" aria-hidden="true" />
}

function fillElement(el: BoardElement, values: Record<string, string>): BoardElement {
  if (el.kind === 'node' || el.kind === 'edge') return el.label === undefined ? el : { ...el, label: fillParams(el.label, values) }
  if (el.kind === 'text') return { ...el, text: fillParams(el.text, values) }
  return el
}
