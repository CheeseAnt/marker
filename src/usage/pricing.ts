import { z } from 'zod'

/** Prices in US dollars. Token prices are per million tokens; audio is per minute. */
export const priceSchema = z.object({
  input: z.number().min(0).optional(),
  cachedInput: z.number().min(0).optional(),
  output: z.number().min(0).optional(),
  audioPerMinute: z.number().min(0).optional(),
})
export type Price = z.infer<typeof priceSchema>

/**
 * Pay-as-you-go list prices for global deployments of common models, as of mid-2025. Azure's
 * prices vary by region, deployment type and agreement, so these are only starting points.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'gpt-4o': { input: 2.5, cachedInput: 1.25, output: 10 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.6 },
  'gpt-4.1': { input: 2, cachedInput: 0.5, output: 8 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cachedInput: 0.025, output: 0.4 },
  'gpt-5': { input: 1.25, cachedInput: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cachedInput: 0.005, output: 0.4 },
  'o4-mini': { input: 1.1, cachedInput: 0.275, output: 4.4 },
  'gpt-4o-transcribe': { audioPerMinute: 0.006 },
  'gpt-4o-mini-transcribe': { audioPerMinute: 0.003 },
  whisper: { audioPerMinute: 0.006 },
}

/**
 * The default price for a deployment or model name, if it is one of the known families.
 * "gpt-4o-2024-08-06" matches gpt-4o, but "gpt-5.6-luna" matches nothing: a new model
 * must not be costed at an older model's price.
 */
export function defaultPrice(name: string | undefined): { family: string; price: Price } | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  const families = Object.keys(DEFAULT_PRICES).sort((a, b) => b.length - a.length)
  const family = families.find((f) => lower === f || (lower.startsWith(`${f}-`) && !/^-(mini|nano)\b/.test(lower.slice(f.length))))
  return family ? { family, price: DEFAULT_PRICES[family] } : undefined
}

/** The user's price for a deployment, else a default for its name or reported model. */
export function priceFor(pricing: Record<string, Price>, deployment: string, model?: string): Price | undefined {
  return pricing[deployment] ?? defaultPrice(deployment)?.price ?? defaultPrice(model)?.price
}

export interface Metered {
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  audioSeconds?: number
}

/**
 * Cost of one call, or undefined when a needed price is missing. Audio priced per minute is
 * billed by length even when the service also reports tokens. Cached input tokens are part of
 * the input count and are billed at the cached rate (the full rate when none is set).
 */
export function costOf(m: Metered, price: Price | undefined): number | undefined {
  if (!price) return undefined
  if (m.audioSeconds !== undefined && price.audioPerMinute !== undefined) return (m.audioSeconds / 60) * price.audioPerMinute
  if (price.input === undefined || price.output === undefined) return m.inputTokens + m.outputTokens === 0 ? 0 : undefined
  const cached = Math.min(m.cachedInputTokens ?? 0, m.inputTokens)
  return ((m.inputTokens - cached) * price.input + cached * (price.cachedInput ?? price.input) + m.outputTokens * price.output) / 1e6
}
