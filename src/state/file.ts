import { del, get, set } from 'idb-keyval'
import { create } from 'zustand'
import { cachedAsset, loadAsset, saveAsset } from '../assets/store'
import { printBoard } from '../dsl/print'
import { emptyHistory } from '../history/history'
import { hashString } from '../model/hash'
import { emptyBoard, type Board } from '../model/types'
import { assetIds, BoardFileError, decodeBoardFile, encodeBoardText, encodeBoardZip, type BoardFile } from '../storage/boardFile'
import { useBoard } from './board'
import { useToast } from './toast'

const FILE_KEY = 'boardbot.file.v1'

/** The browser's file picker API (Chrome, Edge), where it exists. */
type Picker = {
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>
  showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>
}
type Writable = FileSystemFileHandle & {
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>
  queryPermission?(opts: { mode: string }): Promise<string>
  requestPermission?(opts: { mode: string }): Promise<string>
}

const FILE_TYPES = [
  { description: 'BoardBot board', accept: { 'text/plain': ['.board'] } },
  { description: 'BoardBot board, compressed with images', accept: { 'application/zip': ['.boardz'] } },
]

interface StoredFile {
  name: string
  handle: FileSystemFileHandle | null
  savedHash: number
}

interface FileState {
  /** The file the board was last opened from or saved to. */
  name: string | null
  handle: FileSystemFileHandle | null
  /** Hash of the board text as last saved or opened, to tell whether there are unsaved changes. */
  savedHash: number | null
  load: () => Promise<void>
  remember: (file: StoredFile | null) => void
}

export const useFile = create<FileState>((setState) => ({
  name: null,
  handle: null,
  savedHash: null,
  load: async () => {
    try {
      const stored = await get<StoredFile>(FILE_KEY)
      if (stored) setState(stored)
    } catch {
      // No remembered file; Save asks where to save.
    }
  },
  remember: (file) => {
    setState(file ?? { name: null, handle: null, savedHash: null })
    ;(file ? set(FILE_KEY, file) : del(FILE_KEY)).catch(() => undefined)
  },
}))

let lastBoard: Board | null = null
let lastHash = 0
/** Hash of the board's text, cached for the current board object. */
export function boardHash(board: Board): number {
  if (board !== lastBoard) {
    lastBoard = board
    lastHash = hashString(printBoard(board))
  }
  return lastHash
}

/** True when the board differs from what was last saved to (or opened from) a file. */
export function hasUnsavedChanges(board: Board, savedHash: number | null): boolean {
  if (savedHash === null) return board.elements.length > 0
  return boardHash(board) !== savedHash
}

function fileNameFor(board: Board): string {
  const slug = board.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'board'}.board`
}

async function gather(): Promise<BoardFile> {
  const { board, history } = useBoard.getState()
  const assets = []
  for (const id of assetIds(board)) {
    const asset = cachedAsset(id) ?? (await loadAsset(id))
    if (asset) assets.push(asset)
  }
  return { board, assets, history }
}

function encode(file: BoardFile, name: string): Blob {
  return name.endsWith('.boardz')
    ? new Blob([encodeBoardZip(file) as BlobPart], { type: 'application/zip' })
    : new Blob([encodeBoardText(file)], { type: 'text/plain' })
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function writeTo(handle: FileSystemFileHandle, blob: Blob): Promise<boolean> {
  const h = handle as Writable
  // Permission lapses across reloads; asking again needs the user's click, which Save is.
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!h.requestPermission || (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return false
  }
  const writable = await h.createWritable()
  await writable.write(blob)
  await writable.close()
  return true
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Saves to the current file, or asks where (Save as). Returns false if the user cancelled. */
export async function saveBoard(opts: { as?: boolean } = {}): Promise<boolean> {
  const state = useFile.getState()
  const file = await gather()
  const hash = boardHash(file.board)
  const picker = window as unknown as Picker
  try {
    if (!opts.as && state.handle) {
      if (await writeTo(state.handle, encode(file, state.name!))) {
        useFile.getState().remember({ name: state.name!, handle: state.handle, savedHash: hash })
        useToast.getState().show({ kind: 'done', text: `Saved ${state.name}` })
        return true
      }
    }
    if (picker.showSaveFilePicker) {
      const handle = await picker.showSaveFilePicker({ suggestedName: state.name ?? fileNameFor(file.board), types: FILE_TYPES })
      await writeTo(handle, encode(file, handle.name))
      useFile.getState().remember({ name: handle.name, handle, savedHash: hash })
      useToast.getState().show({ kind: 'done', text: `Saved ${handle.name}` })
      return true
    }
    // Without the file picker, the board downloads; the next Save downloads again.
    const name = state.name ?? fileNameFor(file.board)
    download(encode(file, name), name)
    useFile.getState().remember({ name, handle: null, savedHash: hash })
    useToast.getState().show({ kind: 'done', text: `Downloaded ${name}` })
    return true
  } catch (e) {
    if (isAbort(e)) return false
    useToast.getState().show({ kind: 'error', text: `Couldn't save the board: ${(e as Error).message}` })
    return false
  }
}

async function pickFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null> {
  const picker = window as unknown as Picker
  if (picker.showOpenFilePicker) {
    const [handle] = await picker.showOpenFilePicker({ types: [{ description: 'BoardBot board', accept: { 'text/plain': ['.board'], 'application/zip': ['.boardz'] } }] })
    return { file: await handle.getFile(), handle }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.board,.boardz,text/plain,application/zip'
    input.onchange = () => resolve(input.files?.[0] ? { file: input.files[0], handle: null } : null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/** Replaces the open board with a file's board, its images and, if it has one, its history. */
export async function openBoard(): Promise<void> {
  try {
    const picked = await pickFile()
    if (!picked) return
    const file = decodeBoardFile(new Uint8Array(await picked.file.arrayBuffer()))
    await Promise.all(file.assets.map(saveAsset))
    useBoard.getState().load(file.board, file.history ?? emptyHistory())
    useFile.getState().remember({ name: picked.file.name, handle: picked.handle, savedHash: boardHash(file.board) })
    useToast.getState().show({ kind: 'done', text: `Opened ${picked.file.name}${file.history ? ', with its undo history' : ''}` })
  } catch (e) {
    if (isAbort(e)) return
    const message = e instanceof BoardFileError ? e.message : `It isn't a board BoardBot can read (${(e as Error).message}).`
    useToast.getState().show({ kind: 'error', text: `Couldn't open that file. ${message}` })
  }
}

export function newBoard() {
  useBoard.getState().load(emptyBoard())
  useFile.getState().remember(null)
}
