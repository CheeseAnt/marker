import { describe, expect, it, vi } from 'vitest'
import { ProviderError, type LLMProvider } from '../ai/providers/types'
import { useSettings } from '../settings/store'
import { byDeployment, daily, toCsv, totals } from './aggregate'
import { useUsage, type UsageRecord } from './ledger'
import { meterProvider } from './meter'
import { costOf, defaultPrice, priceFor } from './pricing'

describe('pricing', () => {
  it('matches known model families but never guesses for new models', () => {
    expect(defaultPrice('gpt-4o')?.family).toBe('gpt-4o')
    expect(defaultPrice('gpt-4o-2024-08-06')?.family).toBe('gpt-4o')
    expect(defaultPrice('gpt-4o-mini-2024-07-18')?.family).toBe('gpt-4o-mini')
    expect(defaultPrice('gpt-4o-mini-transcribe')?.family).toBe('gpt-4o-mini-transcribe')
    expect(defaultPrice('gpt-5.6-luna')).toBeUndefined()
    expect(defaultPrice('gpt-5.6-luna-2026-07-09')).toBeUndefined()
    expect(defaultPrice('my-gpt-4o')).toBeUndefined()
  })

  it("prefers the user's price, then the deployment name, then the reported model", () => {
    expect(priceFor({ prod: { input: 1, output: 2 } }, 'prod', 'gpt-4o')).toEqual({ input: 1, output: 2 })
    expect(priceFor({}, 'prod', 'gpt-4o-2024-08-06')).toMatchObject({ input: 2.5 })
    expect(priceFor({}, 'gpt-5.6-luna', 'gpt-5.6-luna-2026-07-09')).toBeUndefined()
  })

  it('bills cached input at its own rate and audio by the minute', () => {
    expect(costOf({ inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 }, { input: 2, cachedInput: 0.5, output: 8 })).toBeCloseTo(1.2 + 0.2 + 0.8)
    expect(costOf({ inputTokens: 1000, outputTokens: 0 }, { input: 2 })).toBeUndefined()
    expect(costOf({ inputTokens: 50, outputTokens: 8, audioSeconds: 90 }, { audioPerMinute: 0.006 })).toBeCloseTo(0.009)
    expect(costOf({ inputTokens: 10, outputTokens: 1 }, undefined)).toBeUndefined()
  })
})

const rec = (r: Partial<UsageRecord>): UsageRecord => ({
  id: Math.random().toString(36),
  ts: new Date(2026, 9, 26, 12).getTime(),
  kind: 'chat',
  provider: 'azure-foundry',
  deployment: 'gpt-5.6-luna',
  inputTokens: 1000,
  outputTokens: 100,
  ...r,
})

describe('aggregation', () => {
  const now = new Date(2026, 9, 26, 18).getTime()
  const records = [
    rec({ cost: 0.01 }),
    rec({ ts: new Date(2026, 9, 25, 9).getTime(), cost: 0.02, cachedInputTokens: 500 }),
    rec({ kind: 'transcribe', deployment: 'gpt-4o-transcribe', audioSeconds: 30, inputTokens: 0, outputTokens: 0, cost: 0.003 }),
    rec({ deployment: 'other' }),
  ]

  it('totals with unpriced calls counted separately', () => {
    expect(totals(records)).toMatchObject({ calls: 4, inputTokens: 3000, cachedInputTokens: 500, audioSeconds: 30, unpriced: 1 })
    expect(totals(records).cost).toBeCloseTo(0.033)
  })

  it('fills every day, oldest first', () => {
    const days = daily(records, 3, now)
    expect(days.map((d) => d.totals.calls)).toEqual([0, 1, 3])
  })

  it('groups by deployment and kind, most expensive first', () => {
    expect(byDeployment(records).map((g) => [g.deployment, g.kind, g.totals.calls])).toEqual([
      ['gpt-5.6-luna', 'chat', 2],
      ['gpt-4o-transcribe', 'transcribe', 1],
      ['other', 'chat', 1],
    ])
  })

  it('exports CSV with a header and quoted cells', () => {
    const csv = toCsv([rec({ deployment: 'a,b', cost: 0.0123, estimated: true })])
    expect(csv.split('\n')[0]).toBe('time,kind,provider,deployment,model,input_tokens,cached_input_tokens,output_tokens,audio_seconds,cost_usd,estimated')
    expect(csv.split('\n')[1]).toBe(`${new Date(2026, 9, 26, 12).toISOString()},chat,azure-foundry,"a,b",,1000,0,100,,0.012300,yes`)
  })
})

describe('metering', () => {
  it('records each call with its cost, and estimates a cancelled one', async () => {
    useUsage.setState({ records: [] })
    useSettings.getState().update((s) => ({ ...s, pricing: { prod: { input: 1, output: 4 } } }))
    let fail = false
    const provider: LLMProvider = {
      id: 'azure-foundry',
      label: 'Azure',
      capabilities: { vision: true, tools: true, streaming: true, transcription: false },
      complete: async (_req, { onProgress }) => {
        onProgress?.({ outputTokens: 50 })
        if (fail) throw new ProviderError('aborted', 'Request cancelled.')
        return { text: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1_000_000, outputTokens: 250_000 }, model: 'm' }
      },
      testConnection: vi.fn(),
    }
    const metered = meterProvider(provider, { deployment: 'prod', jobId: 'j1' })
    await metered.complete({ system: 'x'.repeat(400), messages: [] }, {})
    fail = true
    await expect(metered.complete({ system: 'x'.repeat(400), messages: [] }, {})).rejects.toThrow('cancelled')
    const [ok, cut] = useUsage.getState().records
    expect(ok).toMatchObject({ kind: 'chat', deployment: 'prod', model: 'm', jobId: 'j1', cost: 2 })
    expect(cut).toMatchObject({ outputTokens: 50, estimated: true })
    expect(cut.inputTokens).toBeGreaterThan(100)
  })
})
