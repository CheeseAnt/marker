import { ProviderError, type ChatRequest, type LLMProvider, type Usage } from '../ai/providers/types'
import { useSettings } from '../settings/store'
import { useUsage, type UsageKind, type UsageRecord } from './ledger'
import { costOf, priceFor } from './pricing'

export interface MeterContext {
  deployment: string
  transcriptionDeployment?: string
  jobId?: string
}

/** Rough size of a request in tokens, for calls cut off before the service reported usage. */
function estimateInput(req: ChatRequest): number {
  const chars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length
  return Math.round(chars / 4)
}

export function recordUsage(entry: Omit<UsageRecord, 'id' | 'ts' | 'cost'>): UsageRecord {
  const pricing = useSettings.getState().settings.pricing
  const cost = costOf(entry, priceFor(pricing, entry.deployment, entry.model))
  return useUsage.getState().add({ ...entry, ts: Date.now(), ...(cost !== undefined && { cost }) })
}

/**
 * Wraps a provider so every call it makes is written to the usage ledger with its cost,
 * including calls that are cancelled part-way (with estimated tokens).
 */
export function meterProvider(provider: LLMProvider, ctx: MeterContext): LLMProvider {
  const record = (kind: UsageKind, usage: Usage, extra: Partial<UsageRecord> = {}) =>
    recordUsage({
      kind,
      provider: provider.id,
      deployment: ctx.deployment,
      ...(ctx.jobId && { jobId: ctx.jobId }),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedInputTokens && { cachedInputTokens: usage.cachedInputTokens }),
      ...extra,
    })

  const metered: LLMProvider = {
    ...provider,
    complete: async (req, opts) => {
      let streamed = 0
      try {
        const result = await provider.complete(req, {
          ...opts,
          onProgress: (p) => {
            streamed = p.outputTokens
            opts.onProgress?.(p)
          },
        })
        record('chat', result.usage, result.model ? { model: result.model } : {})
        return result
      } catch (e) {
        // A cancelled call is still billed for what was sent and what had streamed back.
        if (e instanceof ProviderError && e.kind === 'aborted') {
          record('chat', { inputTokens: estimateInput(req), outputTokens: streamed }, { estimated: true })
        }
        throw e
      }
    },
    testConnection: async (signal) => {
      const report = await provider.testConnection(signal)
      record('test', report.usage, report.model ? { model: report.model } : {})
      return report
    },
  }
  if (provider.transcribe) {
    const transcribe = provider.transcribe
    metered.transcribe = async (audio, signal) => {
      const result = await transcribe(audio, signal)
      recordUsage({
        kind: 'transcribe',
        provider: provider.id,
        deployment: ctx.transcriptionDeployment ?? ctx.deployment,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        audioSeconds: result.audioSeconds,
      })
      return result
    }
  }
  return metered
}
