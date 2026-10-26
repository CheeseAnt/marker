import { create } from 'zustand'
import { compileBoard, type Compiled } from '../compile/toExcalidraw'
import { describeOps } from '../history/describe'
import {
  emptyHistory,
  jumpTo,
  record,
  redo,
  transactionId,
  undo,
  type ChangeSource,
  type History,
  type Step,
  type Transaction,
} from '../history/history'
import { commit } from '../model/apply'
import type { Op } from '../model/ops'
import { emptyBoard, type Board } from '../model/types'

export type { ChangeSource } from '../history/history'

interface ApplyOptions {
  /** History title; derived from the ops when omitted. */
  title?: string
  prompt?: string
}

interface BoardState {
  board: Board
  compiled: Compiled
  history: History
  /** Bumps on every change; the canvas re-renders from `compiled` when it moves. */
  revision: number
  lastSource: ChangeSource
  /**
   * Applies ops as one undoable transaction. Throws OpError and leaves the board unchanged
   * on failure. Returns undefined when the ops change nothing.
   */
  apply: (ops: readonly Op[], source: ChangeSource, options?: ApplyOptions) => Transaction | undefined
  undo: () => void
  redo: () => void
  jumpTo: (transactionId: string | null) => void
  /** Replaces the board (and history) wholesale, e.g. on startup or when opening a file. */
  load: (board: Board, history?: History) => void
}

/**
 * Called before any history move so edits the canvas has not reported yet are recorded first.
 * The canvas registers the real implementation.
 */
let flushPendingEdits = () => {}
export function setPendingEditsFlusher(fn: () => void) {
  flushPendingEdits = fn
}

export const useBoard = create<BoardState>((set, get) => {
  const initial = emptyBoard()
  const move = (step: (board: Board, history: History) => Step | undefined) => {
    flushPendingEdits()
    const { board, history, revision } = get()
    const next = step(board, history)
    if (!next) return
    set({ board: next.board, history: next.history, compiled: compileBoard(next.board), revision: revision + 1, lastSource: 'system' })
  }

  return {
    board: initial,
    compiled: compileBoard(initial),
    history: emptyHistory(),
    revision: 0,
    lastSource: 'system',
    apply: (ops, source, options = {}) => {
      if (ops.length === 0) return undefined
      const { board, history, revision } = get()
      const applied = commit(board, ops)
      const tx: Transaction = {
        id: transactionId(),
        ts: Date.now(),
        source,
        title: options.title ?? describeOps(board, ops),
        ...(options.prompt !== undefined && { prompt: options.prompt }),
        ops: applied.ops,
        inverse: applied.inverse,
      }
      set({
        board: applied.board,
        compiled: compileBoard(applied.board),
        history: record(history, tx),
        revision: revision + 1,
        lastSource: source,
      })
      return tx
    },
    undo: () => move(undo),
    redo: () => move(redo),
    jumpTo: (id) => move((board, history) => jumpTo(board, history, id)),
    load: (board, history = emptyHistory()) => {
      set({ board, history, compiled: compileBoard(board), revision: get().revision + 1, lastSource: 'system' })
    },
  }
})
