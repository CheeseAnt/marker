import { useState } from 'react'
import { useSettings } from '../settings/store'
import { byDeployment, daily, dayStart, monthStart, since, toCsv, totals, type Totals } from '../usage/aggregate'
import { formatTokens, formatUsd } from '../usage/format'
import { useUsage } from '../usage/ledger'

const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

function Tile({ label, t }: { label: string; t: Totals }) {
  const priced = t.calls > t.unpriced
  return (
    <div className="usage-tile">
      <p className="usage-tile-label">{label}</p>
      <p className="usage-tile-value">{t.calls === 0 ? '—' : priced ? `${t.unpriced ? '≥ ' : ''}${formatUsd(t.cost)}` : `${formatTokens(t.inputTokens + t.outputTokens)} tokens`}</p>
      <p className="usage-tile-detail">
        {t.calls === 0
          ? 'Nothing yet'
          : `${formatTokens(t.inputTokens)} in, ${formatTokens(t.outputTokens)} out${t.audioSeconds ? `, ${Math.round(t.audioSeconds)} s audio` : ''}, ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}`}
      </p>
    </div>
  )
}

/** Clean, compact axis steps: the smallest 1/2/5 × 10ⁿ step giving at most 3 ticks above zero. */
function ticksFor(max: number): number[] {
  if (max <= 0) return [0]
  const raw = max / 3
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!
  const out: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v)
  if (out.at(-1)! < max) out.push(out.at(-1)! + step)
  return out
}

/** Daily usage for the last 30 days: cost when prices are known, otherwise tokens. */
function DailyChart({ days, byCost }: { days: { day: number; totals: Totals }[]; byCost: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const value = (t: Totals) => (byCost ? t.cost : t.inputTokens + t.outputTokens)
  const fmt = (v: number) => (byCost ? formatUsd(v) : formatTokens(v))
  const ticks = ticksFor(Math.max(...days.map((d) => value(d.totals))))
  const top = ticks.at(-1)!
  const W = 440
  const H = 150
  const pad = { left: 44, right: 8, top: 10, bottom: 22 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom
  const slot = plotW / days.length
  const barW = Math.min(24, slot - 2)
  const y = (v: number) => pad.top + plotH - (top ? (v / top) * plotH : 0)
  const shown = hover !== null ? days[hover] : null

  return (
    <figure className="usage-chart">
      <figcaption>{byCost ? 'Cost per day, last 30 days' : 'Tokens per day, last 30 days'}</figcaption>
      <div className="usage-chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${byCost ? 'Cost' : 'Tokens'} per day for the last 30 days`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'usage-baseline' : 'usage-grid'} />
              <text x={pad.left - 6} y={y(t) + 4} className="usage-tick" textAnchor="end">
                {fmt(t)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const v = value(d.totals)
            const x = pad.left + i * slot + (slot - barW) / 2
            const h = Math.max(0, y(0) - y(v))
            const r = Math.min(4, h, barW / 2)
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)}>
                {/* The hit target is the whole column, so small bars are easy to point at. */}
                <rect x={pad.left + i * slot} y={pad.top} width={slot} height={plotH} fill="transparent" />
                {h > 0 && (
                  <path
                    className={`usage-bar ${hover === i ? 'active' : ''}`}
                    d={`M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`}
                  />
                )}
              </g>
            )
          })}
          {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
            <text key={i} x={pad.left + i * slot + slot / 2} y={H - 6} className="usage-tick" textAnchor="middle">
              {day.format(days[i].day)}
            </text>
          ))}
        </svg>
        {shown && (
          <div
            className="usage-tooltip"
            // Anchored on the inside near either edge, so it never runs off the panel.
            style={{
              left: `${((pad.left + hover! * slot + slot / 2) / W) * 100}%`,
              transform: `translate(${hover! > days.length * 0.7 ? '-100%' : hover! < days.length * 0.3 ? '0' : '-50%'}, -100%)`,
            }}
            role="status"
          >
            <strong>{day.format(shown.day)}</strong>
            <span>{shown.totals.calls ? `${fmt(value(shown.totals))}${byCost && shown.totals.unpriced ? ' or more' : ''}` : 'No usage'}</span>
            {shown.totals.calls > 0 && (
              <span>
                {formatTokens(shown.totals.inputTokens + shown.totals.outputTokens)} tokens, {shown.totals.calls} {shown.totals.calls === 1 ? 'call' : 'calls'}
              </span>
            )}
          </div>
        )}
      </div>
      <details className="usage-table-toggle">
        <summary>Show as a table</summary>
        <table className="usage-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => d.totals.calls)
              .map((d) => (
                <tr key={d.day}>
                  <td>{day.format(d.day)}</td>
                  <td>{d.totals.calls}</td>
                  <td>{formatTokens(d.totals.inputTokens + d.totals.outputTokens)}</td>
                  <td>{d.totals.calls > d.totals.unpriced ? formatUsd(d.totals.cost) : 'No price'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

function downloadCsv(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `boardbot-usage-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** What remote models have cost: this session, today, this month, per day and per deployment. */
export function UsagePanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const records = useUsage((s) => s.records)
  const sessionStart = useUsage((s) => s.sessionStart)
  const budget = useSettings((s) => s.settings.budget)
  const [confirming, setConfirming] = useState(false)
  const now = Date.now()
  const month = totals(since(records, monthStart(now)))
  const days = daily(records, 30, now)
  const recent = since(records, days[0].day)
  const byCost = recent.some((r) => r.cost !== undefined && r.cost > 0)
  const groups = byDeployment(since(records, monthStart(now)))
  const unpriced = groups.filter((g) => g.totals.unpriced > 0)
  const limit = budget.limit || budget.warnAt
  const share = limit ? Math.min(1, month.cost / limit) : 0

  return (
    <>
      <div className="drawer-header">
        <h2>Usage</h2>
        <span className="spacer" />
        <button type="button" disabled={!records.length} onClick={() => downloadCsv(toCsv(records))}>
          Export CSV
        </button>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => {
                void useUsage.getState().clear()
                setConfirming(false)
              }}
            >
              Clear all
            </button>
            <button type="button" className="quiet" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="quiet" disabled={!records.length} onClick={() => setConfirming(true)}>
            Clear…
          </button>
        )}
      </div>
      <div className="drawer-scroll usage-panel">
        {records.length === 0 ? (
          <p className="drawer-empty">Each call to a remote model is recorded here with its tokens and cost. Nothing has been sent yet.</p>
        ) : (
          <>
            <div className="usage-tiles">
              <Tile label="This session" t={totals(since(records, sessionStart))} />
              <Tile label="Today" t={totals(since(records, dayStart(now)))} />
              <Tile label="This month" t={month} />
            </div>

            {limit > 0 && (
              <div className={`usage-budget ${budget.limit && month.cost >= budget.limit ? 'over' : budget.warnAt && month.cost >= budget.warnAt ? 'near' : ''}`}>
                <p>
                  {formatUsd(month.cost)} of {budget.limit ? `your ${formatUsd(budget.limit)} monthly limit` : `the ${formatUsd(budget.warnAt)} you wanted a warning at`}
                </p>
                <span className="usage-budget-bar" aria-hidden="true">
                  <span style={{ width: `${share * 100}%` }} />
                </span>
              </div>
            )}

            {unpriced.length > 0 && (
              <p className="usage-note">
                {unpriced.map((g) => g.deployment).join(', ')} {unpriced.length === 1 ? 'has' : 'have'} no price, so costs are incomplete.{' '}
                <button type="button" className="status-link" onClick={onOpenSettings}>
                  Set prices
                </button>
              </p>
            )}

            <DailyChart days={days} byCost={byCost} />

            <table className="usage-table">
              <caption>This month by deployment</caption>
              <thead>
                <tr>
                  <th scope="col">Deployment</th>
                  <th scope="col">Calls</th>
                  <th scope="col">In (cached)</th>
                  <th scope="col">Out</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={`${g.deployment}-${g.kind}`}>
                    <td>
                      {g.deployment}
                      {g.kind === 'transcribe' ? ' (voice)' : ''}
                    </td>
                    <td>{g.totals.calls}</td>
                    <td>
                      {formatTokens(g.totals.inputTokens)}
                      {g.totals.cachedInputTokens ? ` (${formatTokens(g.totals.cachedInputTokens)})` : ''}
                    </td>
                    <td>{g.kind === 'transcribe' && g.totals.audioSeconds ? `${Math.round(g.totals.audioSeconds)} s audio` : formatTokens(g.totals.outputTokens)}</td>
                    <td>{g.totals.calls > g.totals.unpriced ? `${g.totals.unpriced ? '≥ ' : ''}${formatUsd(g.totals.cost)}` : 'No price'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="usage-note">Costs are estimates from the prices in Settings, worked out when each call was made.</p>
          </>
        )}
      </div>
    </>
  )
}
