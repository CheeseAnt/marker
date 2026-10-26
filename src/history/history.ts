import { commit } from '../model/apply'
import type { Op } from '../model/ops'
import type { Board } from '../model/types'

/** Where a change came from. */
export type ChangeSource = 'manual' | 'text' | 'ai' | 'voice' | 'system'

export interface Transaction {
  id: string
  ts: number
  source: ChangeSource
  /** Short description for the history panel. */
  title: string
  /** The request that produced an AI or voice change. */
  prompt?: string
  ops: Op[]
  inverse: Op[]
}

export interface History {
  /** Applied transactions, oldest first. The last one is the current state. */
  past: Transaction[]
  /** Undone transactions, next-to-redo first. */
  future: Transaction[]
}

export const HISTORY_LIMIT = 300

export function emptyHistory(): History {
  return { past: [], future: [] }
}

/** Adds a transaction that was just applied; anything undone before it can no longer be redone. */
export function record(history: History, tx: Transaction, limit = HISTORY_LIMIT): History {
  const past = [...history.past, tx]
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] }
}

export interface Step {
  board: Board
  history: History
}

export function undo(board: Board, history: History): Step | undefined {
  const tx = history.past.at(-1)
  if (!tx) return undefined
  return {
    board: commit(board, tx.inverse).board,
    history: { past: history.past.slice(0, -1), future: [tx, ...history.future] },
  }
}

export function redo(board: Board, history: History): Step | undefined {
  const [tx, ...rest] = history.future
  if (!tx) return undefined
  return {
    board: commit(board, tx.ops).board,
    history: { past: [...history.past, tx], future: rest },
  }
}

/**
 * Moves to the state right after transaction `id` (or before everything when `id` is null),
 * undoing or redoing as many steps as needed.
 */
export function jumpTo(board: Board, history: History, id: string | null): Step {
  let step: Step = { board, history }
  const inPast = id === null ? -1 : history.past.findIndex((t) => t.id === id)
  if (id === null || inPast >= 0) {
    while (step.history.past.length > inPast + 1) step = undo(step.board, step.history)!
    return step
  }
  const inFuture = history.future.findIndex((t) => t.id === id)
  if (inFuture < 0) return step
  for (let i = 0; i <= inFuture; i++) step = redo(step.board, step.history)!
  return step
}

let counter = 0
export function transactionId(): string {
  counter = (counter + 1) % 1_000_000
  return `${Date.now().toString(36)}-${counter.toString(36)}`
}
