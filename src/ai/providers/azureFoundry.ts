import { chatUrl, parseEndpoint, type EndpointStyle } from './azureEndpoint'
import { readSse } from './sse'
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ConnectionReport,
  type LLMProvider,
  type ToolCall,
  type Usage,
} from './types'

export interface AzureFoundryConfig {
  endpoint: string
  deployment: string
  endpointStyle: EndpointStyle | 'auto'
  apiVersion: string
  apiKey: string
  transcriptionDeployment?: string
}

type Fetch = typeof fetch

const DEFAULT_MAX_OUTPUT = 4096
// gpt-4o-transcribe needs this version or later on the deployments endpoint; whisper accepts it too.
const TRANSCRIBE_API_VERSION = '2025-03-01-preview'

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'user':
      return {
        role: 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } })),
      }
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        }),
      }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
  }
}

function toUsage(raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined
  const details = raw.prompt_tokens_details as { cached_tokens?: number } | undefined
  return {
    inputTokens: Number(raw.prompt_tokens ?? 0),
    outputTokens: Number(raw.completion_tokens ?? 0),
    ...(details?.cached_tokens ? { cachedInputTokens: details.cached_tokens } : {}),
  }
}

async function errorFromResponse(res: Response, deployment: string): Promise<ProviderError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } }
    detail = body.error?.message ?? ''
  } catch {
    // Non-JSON error bodies carry nothing more useful than the status.
  }
  const suffix = detail ? ` Azure said: ${detail}` : ''
  switch (res.status) {
    case 401:
    case 403:
      return new ProviderError('auth', `Azure rejected the API key (${res.status}). Check the key in Settings.${suffix}`, { status: res.status })
    case 404:
      return new ProviderError('not-found', `Azure couldn't find deployment "${deployment}" at this endpoint. Check the endpoint URL and deployment name.${suffix}`, { status: 404 })
    case 429: {
      const retry = Number(res.headers.get('retry-after'))
      return new ProviderError('rate-limit', `Azure is rate limiting this deployment. Try again shortly.${suffix}`, {
        status: 429,
        retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined,
      })
    }
    default:
      if (res.status >= 500) return new ProviderError('server', `Azure had a server error (${res.status}).${suffix}`, { status: res.status })
      return new ProviderError('bad-request', `Azure couldn't process the request (${res.status}).${suffix}`, { status: res.status })
  }
}

function mapFetchError(e: unknown, host: string): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof DOMException && e.name === 'AbortError') return new ProviderError('aborted', 'Request cancelled.')
  return new ProviderError(
    'network',
    `Couldn't reach ${host}. Check the endpoint URL and your connection. The browser also blocks this if the service doesn't allow requests from this site.`,
  )
}

export function createAzureFoundryProvider(config: AzureFoundryConfig, fetchImpl: Fetch = (...a) => fetch(...a)): LLMProvider {
  const parsed = parseEndpoint(config.endpoint)
  const style = config.endpointStyle === 'auto' ? parsed?.style : config.endpointStyle
  const deployment = config.deployment.trim() || parsed?.deployment || ''

  const validate = () => {
    if (!parsed) throw new ProviderError('config', 'Add your Azure endpoint URL in Settings (it starts with https://).')
    if (!style) throw new ProviderError('config', 'Choose the endpoint type in Settings; the URL doesn’t say which API it is.')
    if (!deployment) throw new ProviderError('config', 'Add the deployment name in Settings.')
    if (!config.apiKey.trim()) throw new ProviderError('config', 'Add your Azure API key in Settings.')
    return { base: parsed.base, style }
  }

  const complete: LLMProvider['complete'] = async (req, { signal, onProgress } = {}) => {
    const { base, style: resolvedStyle } = validate()
    const { url, model } = chatUrl(base, resolvedStyle, deployment, config.apiVersion || parsed?.apiVersion)
    const body: Record<string, unknown> = {
      messages: [{ role: 'system', content: req.system }, ...req.messages.map(toWireMessage)],
      stream: true,
      max_completion_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
      ...(model && { model }),
      ...(resolvedStyle !== 'models' && { stream_options: { include_usage: true } }),
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      if (req.toolChoice) {
        body.tool_choice = typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } }
      }
    }

    const host = new URL(url).host
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-key': config.apiKey.trim() },
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      throw mapFetchError(e, host)
    }
    if (!res.ok) throw await errorFromResponse(res, deployment)
    if (!res.body) throw new ProviderError('server', 'Azure returned an empty response.')

    let text = ''
    let finishReason: string | null = null
    let usage: Usage | undefined
    let reportedModel: string | undefined
    const calls: { id: string; name: string; arguments: string }[] = []
    let streamedChars = 0
    try {
      for await (const data of readSse(res.body, signal)) {
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (typeof chunk.model === 'string' && chunk.model) reportedModel = chunk.model
        usage = toUsage(chunk.usage as Record<string, unknown> | undefined) ?? usage
        const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = String(choice.finish_reason)
        const delta = (choice.delta ?? {}) as { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }
        if (delta.content) {
          text += delta.content
          streamedChars += delta.content.length
        }
        for (const part of delta.tool_calls ?? []) {
          const call = (calls[part.index] ??= { id: '', name: '', arguments: '' })
          if (part.id) call.id = part.id
          if (part.function?.name) call.name += part.function.name
          if (part.function?.arguments) {
            call.arguments += part.function.arguments
            streamedChars += part.function.arguments.length
          }
        }
        // Roughly four characters per token; exact counts arrive with the final usage chunk.
        onProgress?.({ outputTokens: Math.round(streamedChars / 4) })
      }
    } catch (e) {
      throw mapFetchError(e, host)
    }
    if (signal?.aborted) throw new ProviderError('aborted', 'Request cancelled.')
    if (finishReason === 'content_filter') {
      throw new ProviderError('bad-request', 'Azure’s content filter blocked this request or its answer.')
    }
    const toolCalls: ToolCall[] = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments }))
    return {
      text,
      toolCalls,
      finishReason,
      usage: usage ?? { inputTokens: 0, outputTokens: Math.round(streamedChars / 4) },
      ...(reportedModel && { model: reportedModel }),
    }
  }

  const testConnection = async (signal?: AbortSignal): Promise<ConnectionReport> => {
    const started = performance.now()
    const probe: ChatRequest = {
      system: 'You are a connectivity check.',
      messages: [{ role: 'user', content: 'Call the confirm tool with ok set to true.' }],
      tools: [
        {
          name: 'confirm',
          description: 'Confirms the connection works.',
          parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      ],
      toolChoice: 'required',
      maxOutputTokens: 400,
    }
    try {
      const r = await complete(probe, { signal })
      return {
        model: r.model,
        latencyMs: Math.round(performance.now() - started),
        toolCalling: r.toolCalls.some((c) => c.name === 'confirm'),
        usage: r.usage,
      }
    } catch (e) {
      // Some deployments reject tools outright; report that instead of failing the whole check.
      if (e instanceof ProviderError && e.kind === 'bad-request' && /tool/i.test(e.message)) {
        const r = await complete({ ...probe, tools: undefined, toolChoice: undefined, messages: [{ role: 'user', content: 'Reply with OK.' }] }, { signal })
        return { model: r.model, latencyMs: Math.round(performance.now() - started), toolCalling: false, usage: r.usage }
      }
      throw e
    }
  }

  const transcriptionDeployment = config.transcriptionDeployment?.trim()
  const transcribe = async (audio: Blob, signal?: AbortSignal) => {
    const { base, style: resolvedStyle } = validate()
    // Foundry resources serve the OpenAI audio routes on the same host as chat.
    const url =
      resolvedStyle === 'v1'
        ? `${base}/openai/v1/audio/transcriptions`
        : `${base}/openai/deployments/${encodeURIComponent(transcriptionDeployment!)}/audio/transcriptions?api-version=${TRANSCRIBE_API_VERSION}`
    const form = new FormData()
    form.append('file', audio, 'speech.wav')
    form.append('response_format', 'json')
    form.append('language', 'en')
    if (resolvedStyle === 'v1') form.append('model', transcriptionDeployment!)
    let res: Response
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'api-key': config.apiKey.trim() }, body: form, signal })
    } catch (e) {
      throw mapFetchError(e, new URL(url).host)
    }
    if (!res.ok) throw await errorFromResponse(res, transcriptionDeployment!)
    const body = (await res.json()) as { text?: string; usage?: { input_tokens?: number; output_tokens?: number } }
    // A WAV header is 44 bytes; the rest is 16-bit samples at 16 kHz.
    const audioSeconds = Math.max(0, (audio.size - 44) / 2 / 16_000)
    return {
      text: (body.text ?? '').trim(),
      audioSeconds,
      ...(body.usage && { usage: { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 } }),
    }
  }

  return {
    id: 'azure-foundry',
    label: 'Azure AI Foundry',
    capabilities: { vision: true, tools: true, streaming: true, transcription: Boolean(transcriptionDeployment) },
    complete,
    testConnection,
    ...(transcriptionDeployment && { transcribe }),
  }
}
