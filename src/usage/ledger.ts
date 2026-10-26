import { clear, createStore, set, values } from 'idb-keyval'
import { create } from 'zustand'

export type UsageKind = 'chat' | 'transcribe' | 'test'

/** One call to a remote model. */
export interface UsageRecord {
  id: string
  ts: number
  kind: UsageKind
  provider: string
  deployment: string
  /** The model name the service reported, when it did. */
  model?: string
  jobId?: string
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  audioSeconds?: number
  /** US dollars at the price in force when the call was made; undefined if no price was set. */
  cost?: number
  /** True when the call was cut short and its tokens are estimates. */
  estimated?: boolean
}

let opened: ReturnType<typeof createStore> | null = null
/** The records store, opened on first use; undefined where the browser has no IndexedDB. */
function store() {
  if (typeof indexedDB === 'undefined') return undefined
  opened ??= createStore('boardbot-usage', 'records')
  return opened
}
let counter = 0

interface UsageState {
  records: UsageRecord[]
  loaded: boolean
  /** When this page was opened, for "this session" totals. */
  sessionStart: number
  load: () => Promise<void>
  add: (record: Omit<UsageRecord, 'id'>) => UsageRecord
  clear: () => Promise<void>
}

export const useUsage = create<UsageState>((setState, getState) => ({
  records: [],
  loaded: false,
  sessionStart: Date.now(),
  load: async () => {
    try {
      const db = store()
      const stored = db ? await values<UsageRecord>(db) : []
      // Records added before loading finished are kept.
      const known = new Set(stored.map((r) => r.id))
      const merged = [...stored, ...getState().records.filter((r) => !known.has(r.id))].sort((a, b) => a.ts - b.ts)
      setState({ records: merged, loaded: true })
    } catch {
      setState({ loaded: true })
    }
  },
  add: (record) => {
    const full = { ...record, id: `${record.ts.toString(36)}-${(counter++).toString(36)}` }
    setState({ records: [...getState().records, full] })
    const db = store()
    // Without storage it is still counted for this session; it just won't be remembered.
    if (db) set(full.id, full, db).catch(() => undefined)
    return full
  },
  clear: async () => {
    setState({ records: [] })
    const db = store()
    if (db) await clear(db).catch(() => undefined)
  },
}))
