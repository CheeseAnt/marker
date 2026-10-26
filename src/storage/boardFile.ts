import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Asset } from '../assets/store'
import { parseBoard } from '../dsl/parse'
import { printBoard } from '../dsl/print'
import type { History } from '../history/history'
import { hashString } from '../model/hash'
import type { Board } from '../model/types'

/** Everything a board file carries. History is optional, and only valid for exactly this board. */
export interface BoardFile {
  board: Board
  assets: Asset[]
  history?: History
}

export type BoardFileFormat = 'board' | 'boardz'

const ASSET_LINE = '#@asset '
const HISTORY_LINE = '#@history '

export class BoardFileError extends Error {}

/** Image asset ids a board shows, including inside its embedded templates. */
export function assetIds(board: Board): string[] {
  const ids = new Set<string>()
  const visit = (b: Board) => b.elements.forEach((e) => e.kind === 'image' && ids.add(e.asset))
  visit(board)
  Object.values(board.definitions).forEach(visit)
  return [...ids]
}

function base64(dataURL: string): { mime: string; data: string } {
  const m = dataURL.match(/^data:([^;,]+);base64,(.*)$/)
  if (!m) throw new BoardFileError('An image could not be saved: it is not stored as base64 data.')
  return { mime: m[1], data: m[2] }
}

function bytesOf(dataURL: string): Uint8Array {
  return Uint8Array.from(atob(base64(dataURL).data), (c) => c.charCodeAt(0))
}

function dataURLOf(mime: string, bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * One text file: the board, then its images and (optionally) its history as comment lines,
 * so the whole file is still ordinary board text.
 */
export function encodeBoardText(file: BoardFile): string {
  const text = printBoard(file.board)
  const lines = [text.trimEnd()]
  if (file.assets.length || file.history) lines.push('')
  for (const a of file.assets) {
    const { mime, data } = base64(a.dataURL)
    lines.push(`${ASSET_LINE}${a.id} ${mime} ${a.width}x${a.height} ${data}`)
  }
  if (file.history) lines.push(`${HISTORY_LINE}${hashString(text)} ${JSON.stringify(file.history)}`)
  return lines.join('\n') + '\n'
}

export function decodeBoardText(text: string): BoardFile {
  const lines = text.split('\n')
  const ours = (l: string) => l.startsWith(ASSET_LINE) || l.startsWith(HISTORY_LINE)
  const board = parseBoard(lines.filter((l) => !ours(l)).join('\n').replace(/\n+$/, '\n'))
  const assets: Asset[] = []
  let history: History | undefined
  for (const line of lines) {
    if (line.startsWith(ASSET_LINE)) {
      const [id, mime, size, data] = line.slice(ASSET_LINE.length).split(' ')
      const [width, height] = (size ?? '').split('x').map(Number)
      if (!id || !mime || !data) throw new BoardFileError('An image in this file is damaged.')
      assets.push({ id, mimeType: mime, dataURL: `data:${mime};base64,${data}`, width: width || 0, height: height || 0, created: Date.now() })
    } else if (line.startsWith(HISTORY_LINE)) {
      // History only fits the exact board it was saved with; a hand-edited file loses it.
      const rest = line.slice(HISTORY_LINE.length)
      const space = rest.indexOf(' ')
      if (Number(rest.slice(0, space)) === hashString(printBoard(board))) history = readHistory(rest.slice(space + 1))
    }
  }
  return { board, assets, ...(history && { history }) }
}

function readHistory(json: string | undefined): History | undefined {
  try {
    const h = JSON.parse(json ?? '') as History
    return Array.isArray(h.past) && Array.isArray(h.future) ? h : undefined
  } catch {
    return undefined
  }
}

/** A zip: board.board (text), assets/<id> (raw bytes, listed in assets.json) and history.json. */
export function encodeBoardZip(file: BoardFile): Uint8Array {
  const text = printBoard(file.board)
  const entries: Record<string, Uint8Array> = { 'board.board': strToU8(text) }
  const index = file.assets.map((a) => ({ id: a.id, mimeType: a.mimeType, width: a.width, height: a.height }))
  for (const a of file.assets) entries[`assets/${a.id}`] = bytesOf(a.dataURL)
  if (index.length) entries['assets.json'] = strToU8(JSON.stringify(index))
  if (file.history) entries['history.json'] = strToU8(JSON.stringify({ boardHash: hashString(text), history: file.history }))
  // Images are already compressed; zipping them again only costs time.
  return zipSync(entries, { level: 6, mem: 8 })
}

export function decodeBoardZip(bytes: Uint8Array): BoardFile {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new BoardFileError('This file is not a BoardBot board (it is not a valid zip).')
  }
  if (!files['board.board']) throw new BoardFileError('This zip has no board.board, so it is not a BoardBot board.')
  const text = strFromU8(files['board.board'])
  const board = parseBoard(text)
  const index = files['assets.json'] ? (JSON.parse(strFromU8(files['assets.json'])) as Omit<Asset, 'dataURL' | 'created'>[]) : []
  const assets = index.flatMap((a) => {
    const data = files[`assets/${a.id}`]
    return data ? [{ ...a, dataURL: dataURLOf(a.mimeType, data), created: Date.now() }] : []
  })
  let history: History | undefined
  if (files['history.json']) {
    const stored = JSON.parse(strFromU8(files['history.json'])) as { boardHash: number; history: History }
    if (stored.boardHash === hashString(printBoard(board))) history = stored.history
  }
  return { board, assets, ...(history && { history }) }
}

/** Reads either format, deciding by content rather than by name. */
export function decodeBoardFile(bytes: Uint8Array): BoardFile {
  // Zip files start with "PK".
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return decodeBoardZip(bytes)
  return decodeBoardText(strFromU8(bytes))
}
