import { describe, expect, it } from 'vitest'
import { emptyHistory, record, type Transaction } from '../history/history'
import { formatRecent, recentContext, RECENT_WINDOW_MS } from './recent'

const now = 10_000_000
const tx = (id: string, ts: number, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  ts,
  source: 'manual',
  title: `Change ${id}`,
  ops: [{ op: 'update', id: `n_${id}`, set: { label: 'x' } }],
  inverse: [],
  ...extra,
})

describe('recent context', () => {
  it('lists the newest changes first and the conversation oldest first, within the window', () => {
    let history = emptyHistory()
    for (const t of [
      tx('old', now - RECENT_WINDOW_MS - 1),
      tx('a', now - 5000),
      tx('b', now - 4000, { source: 'ai', prompt: 'add a cache', title: 'Added a cache', ops: [{ op: 'add', element: { kind: 'node', id: 'cache', label: 'Cache', shape: 'rect', style: {}, hints: {} } }] }),
    ])
      history = record(history, t)
    const text = formatRecent(
      recentContext(
        history,
        [
          { prompt: 'stale', ts: now - RECENT_WINDOW_MS - 1, outcome: { kind: 'cancelled' } },
          { prompt: 'what should I add?', ts: now - 6000, outcome: { kind: 'reply', message: 'I suggest a cache between the API and DB. Shall I add it?' } },
          { prompt: 'add a cache', ts: now - 4000, outcome: { kind: 'edit', title: 'Added a cache' } },
        ],
        now,
      ),
    )
    expect(text).toBe(
      [
        'Recent conversation, oldest first:',
        'User: "what should I add?"',
        '  You replied: "I suggest a cache between the API and DB. Shall I add it?"',
        'User: "add a cache"',
        '  You changed the board: Added a cache',
        '',
        'Recent changes to the board, newest first (undo_first: n undoes the n newest):',
        '1. Request "add a cache": Added a cache (cache)',
        '2. Canvas edit: Change a (n_a)',
      ].join('\n'),
    )
  })

  it('is empty when nothing happened recently', () => {
    expect(formatRecent(recentContext(emptyHistory(), [], now))).toBe('')
  })
})
