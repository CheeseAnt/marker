import type { UsageRecord } from './ledger'

export interface Totals {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  audioSeconds: number
  /** Sum of the costs that are known. */
  cost: number
  /** Calls with no price, so `cost` is a lower bound. */
  unpriced: number
}

export function emptyTotals(): Totals {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, audioSeconds: 0, cost: 0, unpriced: 0 }
}

export function addTo(t: Totals, r: UsageRecord): Totals {
  return {
    calls: t.calls + 1,
    inputTokens: t.inputTokens + r.inputTokens,
    cachedInputTokens: t.cachedInputTokens + (r.cachedInputTokens ?? 0),
    outputTokens: t.outputTokens + r.outputTokens,
    audioSeconds: t.audioSeconds + (r.audioSeconds ?? 0),
    cost: t.cost + (r.cost ?? 0),
    unpriced: t.unpriced + (r.cost === undefined ? 1 : 0),
  }
}

export function totals(records: UsageRecord[]): Totals {
  return records.reduce(addTo, emptyTotals())
}

/** Local midnight of the day `ts` falls in. */
export function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function monthStart(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

export function since(records: UsageRecord[], from: number): UsageRecord[] {
  return records.filter((r) => r.ts >= from)
}

/** One entry per day for the last `days` days, oldest first, including empty days. */
export function daily(records: UsageRecord[], days: number, now = Date.now()): { day: number; totals: Totals }[] {
  const out: { day: number; totals: Totals }[] = []
  const today = new Date(dayStart(now))
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    out.push({ day: d.getTime(), totals: emptyTotals() })
  }
  const index = new Map(out.map((e, i) => [e.day, i]))
  for (const r of records) {
    const i = index.get(dayStart(r.ts))
    if (i !== undefined) out[i].totals = addTo(out[i].totals, r)
  }
  return out
}

/** Totals per deployment and kind, most expensive first. */
export function byDeployment(records: UsageRecord[]): { deployment: string; kind: UsageRecord['kind']; totals: Totals }[] {
  const groups = new Map<string, { deployment: string; kind: UsageRecord['kind']; totals: Totals }>()
  for (const r of records) {
    const kind = r.kind === 'test' ? 'chat' : r.kind
    const key = `${r.deployment}\u0000${kind}`
    const g = groups.get(key) ?? { deployment: r.deployment, kind, totals: emptyTotals() }
    g.totals = addTo(g.totals, r)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.totals.cost - a.totals.cost || b.totals.inputTokens - a.totals.inputTokens)
}

const CSV_COLUMNS = ['time', 'kind', 'provider', 'deployment', 'model', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'audio_seconds', 'cost_usd', 'estimated'] as const

function csvCell(v: string | number | undefined): string {
  if (v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(records: UsageRecord[]): string {
  const rows = records.map((r) =>
    [
      new Date(r.ts).toISOString(),
      r.kind,
      r.provider,
      r.deployment,
      r.model,
      r.inputTokens,
      r.cachedInputTokens ?? 0,
      r.outputTokens,
      r.audioSeconds !== undefined ? Math.round(r.audioSeconds * 10) / 10 : undefined,
      r.cost !== undefined ? r.cost.toFixed(6) : undefined,
      r.estimated ? 'yes' : '',
    ]
      .map(csvCell)
      .join(','),
  )
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n'
}
