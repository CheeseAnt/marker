import type { History, Transaction } from '../history/history'
import type { Op } from '../model/ops'

export const RECENT_WINDOW_MS = 30 * 60 * 1000
export const RECENT_CHANGES = 5
export const RECENT_TURNS = 4

/** A finished request and how it ended, as the model should remember it. */
export interface RecentTurn {
  prompt: string
  ts: number
  outcome: { kind: 'edit'; title: string } | { kind: 'reply'; message: string } | { kind: 'failed'; error: string } | { kind: 'cancelled' }
}

export interface RecentContext {
  /** Newest first, at most RECENT_CHANGES, from history.past. */
  changes: Transaction[]
  /** Oldest first, at most RECENT_TURNS. */
  turns: RecentTurn[]
}

const SOURCE: Record<Transaction['source'], string> = {
  manual: 'Canvas edit',
  text: 'Board text edit',
  ai: 'Request',
  voice: 'Spoken request',
  system: 'Marker',
}

function idsOf(ops: Op[]): string[] {
  const ids = new Set<string>()
  for (const o of ops) {
    if (o.op === 'add' || o.op === 'replace') ids.add(o.element.id)
    else if (o.op === 'update' || o.op === 'remove' || o.op === 'reorder') ids.add(o.id)
  }
  return [...ids]
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function recentContext(history: History, turns: RecentTurn[], now = Date.now()): RecentContext {
  const fresh = (ts: number) => now - ts <= RECENT_WINDOW_MS
  return {
    changes: history.past.slice(-RECENT_CHANGES).reverse().filter((t) => fresh(t.ts)),
    turns: turns.filter((t) => fresh(t.ts)).slice(-RECENT_TURNS),
  }
}

/** The recent-context part of the user message; empty when nothing recent happened. */
export function formatRecent({ changes, turns }: RecentContext): string {
  const parts: string[] = []
  if (turns.length) {
    const lines = turns.map((t) => {
      const said = `User: "${clip(t.prompt, 200)}"`
      switch (t.outcome.kind) {
        case 'edit':
          return `${said}\n  You changed the board: ${t.outcome.title}`
        case 'reply':
          return `${said}\n  You replied: "${clip(t.outcome.message, 400)}"`
        case 'failed':
          return `${said}\n  That failed: ${clip(t.outcome.error, 160)}`
        case 'cancelled':
          return `${said}\n  The user cancelled it.`
      }
    })
    parts.push(`Recent conversation, oldest first:\n${lines.join('\n')}`)
  }
  if (changes.length) {
    const lines = changes.map((t, i) => {
      const ids = idsOf(t.ops)
      const who = t.prompt ? `${SOURCE[t.source]} "${clip(t.prompt, 120)}"` : SOURCE[t.source]
      return `${i + 1}. ${who}: ${t.title}${ids.length ? ` (${clip(ids.join(', '), 120)})` : ''}`
    })
    parts.push(
      `Recent changes to the board, newest first (undo_first: n undoes the n newest):\n${lines.join('\n')}`,
    )
  }
  return parts.join('\n\n')
}
