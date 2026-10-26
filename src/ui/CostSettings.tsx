import { useId } from 'react'
import type { Settings } from '../settings/schema'
import { useUsage } from '../usage/ledger'
import { defaultPrice, type Price } from '../usage/pricing'

type Pricing = Settings['pricing']
type Budget = Settings['budget']

const TOKEN_FIELDS: [keyof Price, string][] = [
  ['input', 'Input, $ per 1M tokens'],
  ['cachedInput', 'Cached input, $ per 1M'],
  ['output', 'Output, $ per 1M tokens'],
]

function NumberInput({ label, value, placeholder, onChange }: { label: string; value?: number; placeholder?: number; onChange: (v: number | undefined) => void }) {
  return (
    <input
      type="number"
      min={0}
      step="any"
      inputMode="decimal"
      aria-label={label}
      placeholder={placeholder !== undefined ? String(placeholder) : ''}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
    />
  )
}

interface Props {
  pricing: Pricing
  budget: Budget
  deployments: { name: string; kind: 'chat' | 'transcribe' }[]
  onPricing: (p: Pricing) => void
  onBudget: (b: Budget) => void
}

/** Prices per deployment (blank uses the default shown, if there is one) and the monthly budget. */
export function CostSettings({ pricing, budget, deployments, onPricing, onBudget }: Props) {
  const seen = useUsage((s) => s.records)
  const warnId = useId()
  const limitId = useId()
  const names = new Map(deployments.filter((d) => d.name).map((d) => [d.name, d.kind]))
  for (const r of seen) if (!names.has(r.deployment)) names.set(r.deployment, r.kind === 'transcribe' ? 'transcribe' : 'chat')
  for (const name of Object.keys(pricing)) if (!names.has(name)) names.set(name, 'chat')

  const setPrice = (name: string, key: keyof Price, value: number | undefined) => {
    const next = { ...pricing[name], [key]: value }
    if (value === undefined) delete next[key]
    const rest = { ...pricing }
    if (Object.keys(next).length) rest[name] = next
    else delete rest[name]
    onPricing(rest)
  }

  return (
    <section className="settings-section" aria-labelledby="costs-heading">
      <h3 id="costs-heading">Costs</h3>
      <p className="settings-lede">
        Used to estimate what each request costs. Azure prices depend on region and deployment type, so check them against your Azure
        pricing. Leave a field empty to use the default shown. Changes apply to new usage.
      </p>
      {names.size === 0 ? (
        <p className="field-hint">Add a deployment above to set its prices.</p>
      ) : (
        <div className="price-table">
          {[...names].map(([name, kind]) => {
            const fallback = defaultPrice(name)
            const own = pricing[name] ?? {}
            return (
              <fieldset key={name} className="price-row">
                <legend>
                  {name}
                  <span className="price-default">
                    {fallback ? ` Defaults are ${fallback.family} list prices.` : ' No default price: enter yours to see costs.'}
                  </span>
                </legend>
                <div className="price-fields">
                  {kind === 'transcribe' ? (
                    <label>
                      $ per minute of audio
                      <NumberInput label={`${name}: $ per minute of audio`} value={own.audioPerMinute} placeholder={fallback?.price.audioPerMinute} onChange={(v) => setPrice(name, 'audioPerMinute', v)} />
                    </label>
                  ) : (
                    TOKEN_FIELDS.map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <NumberInput label={`${name}: ${label}`} value={own[key]} placeholder={fallback?.price[key]} onChange={(v) => setPrice(name, key, v)} />
                      </label>
                    ))
                  )}
                </div>
              </fieldset>
            )
          })}
        </div>
      )}

      <div className="budget-fields">
        <div className="field">
          <label htmlFor={warnId}>Warn me when this month passes ($)</label>
          <input id={warnId} type="number" min={0} step="any" placeholder="No warning" value={budget.warnAt || ''} onChange={(e) => onBudget({ ...budget, warnAt: Number(e.target.value) || 0 })} />
        </div>
        <div className="field">
          <label htmlFor={limitId}>Stop sending requests at ($)</label>
          <input id={limitId} type="number" min={0} step="any" placeholder="No limit" value={budget.limit || ''} onChange={(e) => onBudget({ ...budget, limit: Number(e.target.value) || 0 })} />
          <p className="field-hint">You can still send a request past the limit when you choose to.</p>
        </div>
      </div>
    </section>
  )
}
