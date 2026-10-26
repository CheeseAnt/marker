import { describe, expect, it, vi } from 'vitest'
import { chatUrl, parseEndpoint } from './azureEndpoint'
import { createAzureFoundryProvider, type AzureFoundryConfig } from './azureFoundry'
import { readSse } from './sse'
import { ProviderError } from './types'

const config: AzureFoundryConfig = {
  endpoint: 'https://res.openai.azure.com/',
  deployment: 'gpt-5.6-luna',
  endpointStyle: 'auto',
  apiVersion: '',
  apiKey: ' secret ',
}

function sseResponse(events: unknown[], split = 7): Response {
  const text = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  // Deliberately awkward chunk boundaries.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('parseEndpoint', () => {
  it.each([
    ['res.openai.azure.com', { base: 'https://res.openai.azure.com', style: 'deployments' }],
    [
      'https://res.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2025-01-01-preview',
      { base: 'https://res.openai.azure.com', style: 'deployments', deployment: 'gpt-5.6-luna', apiVersion: '2025-01-01-preview' },
    ],
    ['https://res.openai.azure.com/openai/v1/', { base: 'https://res.openai.azure.com', style: 'v1' }],
    [
      'https://res.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview',
      { base: 'https://res.services.ai.azure.com', style: 'models', apiVersion: '2024-05-01-preview' },
    ],
    ['https://example.com', { base: 'https://example.com' }],
  ])('%s', (input, expected) => {
    expect(parseEndpoint(input)).toEqual(expected)
  })

  it('rejects non-https and junk', () => {
    expect(parseEndpoint('http://res.openai.azure.com')).toBeUndefined()
    expect(parseEndpoint('  ')).toBeUndefined()
  })

  it('builds request URLs per style', () => {
    expect(chatUrl('https://r.openai.azure.com', 'deployments', 'd 1').url).toBe(
      'https://r.openai.azure.com/openai/deployments/d%201/chat/completions?api-version=2024-10-21',
    )
    expect(chatUrl('https://r.openai.azure.com', 'v1', 'd')).toEqual({ url: 'https://r.openai.azure.com/openai/v1/chat/completions', model: 'd' })
    expect(chatUrl('https://r.services.ai.azure.com', 'models', 'd', '2025-01-01')).toEqual({
      url: 'https://r.services.ai.azure.com/models/chat/completions?api-version=2025-01-01',
      model: 'd',
    })
  })
})

describe('readSse', () => {
  it('reassembles events split across chunks and stops at [DONE]', async () => {
    const res = sseResponse([{ a: 1 }, 'multi', { b: 2 }, '[DONE]', { never: true }], 3)
    const out: string[] = []
    for await (const d of readSse(res.body!)) out.push(d)
    expect(out).toEqual(['{"a":1}', 'multi', '{"b":2}'])
  })
})

describe('Azure Foundry provider', () => {
  it('streams text and tool calls, and reports usage', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [], prompt_filter_results: [] },
        { model: 'gpt-5.6-luna-2026', choices: [{ index: 0, delta: { role: 'assistant', content: 'Draw' } }] },
        { choices: [{ index: 0, delta: { content: 'ing.' } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'apply_ops', arguments: '{"ops":' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '[]}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 64 } } },
        '[DONE]',
      ]),
    )
    const provider = createAzureFoundryProvider(config, fetchMock as unknown as typeof fetch)
    const progress: number[] = []
    const result = await provider.complete(
      {
        system: 'sys',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', dataUrl: 'data:image/png;base64,AA' }] }],
        tools: [{ name: 'apply_ops', description: 'd', parameters: { type: 'object' } }],
        toolChoice: { name: 'apply_ops' },
      },
      { onProgress: (p) => progress.push(p.outputTokens) },
    )
    expect(result).toEqual({
      text: 'Drawing.',
      toolCalls: [{ id: 'call_1', name: 'apply_ops', arguments: '{"ops":[]}' }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 64 },
      model: 'gpt-5.6-luna-2026',
    })
    expect(progress.length).toBeGreaterThan(0)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://res.openai.azure.com/openai/deployments/gpt-5.6-luna/chat/completions?api-version=2024-10-21')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'api-key': 'secret' })
    const body = JSON.parse(String(init.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } })
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'apply_ops' } })
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body).not.toHaveProperty('model')
  })

  it.each([
    [401, 'auth', /rejected the API key/],
    [404, 'not-found', /couldn't find deployment "gpt-5.6-luna"/],
    [429, 'rate-limit', /rate limiting/],
    [400, 'bad-request', /Azure said: bad things/],
    [503, 'server', /server error/],
  ])('maps HTTP %i to %s', async (status, kind, message) => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad things' } }), { status, headers: { 'retry-after': '3' } }),
    )
    const provider = createAzureFoundryProvider(config, fetchMock as unknown as typeof fetch)
    const err = await provider.complete({ system: '', messages: [] }, {}).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe(kind)
    expect(err.message).toMatch(message)
    if (status === 429) expect(err.retryAfterMs).toBe(3000)
  })

  it('explains network failures and missing settings', async () => {
    const offline = createAzureFoundryProvider(config, (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch)
    await expect(offline.complete({ system: '', messages: [] }, {})).rejects.toMatchObject({ kind: 'network', message: /Couldn't reach res.openai.azure.com/ })

    const noKey = createAzureFoundryProvider({ ...config, apiKey: '' })
    await expect(noKey.complete({ system: '', messages: [] }, {})).rejects.toMatchObject({ kind: 'config', message: /API key/ })
    const unknownHost = createAzureFoundryProvider({ ...config, endpoint: 'https://example.com' })
    await expect(unknownHost.complete({ system: '', messages: [] }, {})).rejects.toMatchObject({ kind: 'config', message: /endpoint type/ })
  })

  it('takes the deployment from a pasted URL and reports tool support in the connection test', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'confirm', arguments: '{"ok":true}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } },
      ]),
    )
    const provider = createAzureFoundryProvider(
      { ...config, deployment: '', endpoint: 'https://res.openai.azure.com/openai/deployments/from-url/chat/completions?api-version=2025-01-01' },
      fetchMock as unknown as typeof fetch,
    )
    const report = await provider.testConnection()
    expect(report.toolCalling).toBe(true)
    expect(report.usage).toEqual({ inputTokens: 40, outputTokens: 5 })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://res.openai.azure.com/openai/deployments/from-url/chat/completions?api-version=2025-01-01',
    )
  })
})
