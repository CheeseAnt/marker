import { create } from 'zustand'
import { compileBoard, type Compiled } from '../compile/toExcalidraw'
import { commit, type Applied } from '../model/apply'
import type { Op } from '../model/ops'
import { emptyBoard, type Board } from '../model/types'

/** Where a change came from; history (phase 3) records it per transaction. */
export type ChangeSource = 'manual' | 'text' | 'ai' | 'voice' | 'system'

interface BoardState {
  board: Board
  compiled: Compiled
  /** Bumps on every change; the canvas re-renders from `compiled` when it moves. */
  revision: number
  lastSource: ChangeSource
  /** Applies ops as one unit. Throws OpError and leaves the board unchanged on failure. */
  apply: (ops: readonly Op[], source: ChangeSource) => Applied
  load: (board: Board) => void
}

export const useBoard = create<BoardState>((set, get) => {
  const initial = emptyBoard()
  return {
    board: initial,
    compiled: compileBoard(initial),
    revision: 0,
    lastSource: 'system',
    apply: (ops, source) => {
      const applied = commit(get().board, ops)
      set({ board: applied.board, compiled: compileBoard(applied.board), revision: get().revision + 1, lastSource: source })
      return applied
    },
    load: (board) => {
      set({ board, compiled: compileBoard(board), revision: get().revision + 1, lastSource: 'system' })
    },
  }
})
