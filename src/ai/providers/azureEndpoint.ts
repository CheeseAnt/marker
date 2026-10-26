/**
 * Azure exposes chat completions under three URL shapes. All accept the `api-key` header and
 * were confirmed to allow browser (CORS) calls on 2026-10-26.
 *   deployments  https://<res>.openai.azure.com/openai/deployments/<dep>/chat/completions?api-version=...
 *   v1           https://<res>.openai.azure.com/openai/v1/chat/completions          (model = deployment)
 *   models       https://<res>.services.ai.azure.com/models/chat/completions?api-version=...
 */
export type EndpointStyle = 'deployments' | 'v1' | 'models'

export const DEFAULT_API_VERSION: Record<EndpointStyle, string | null> = {
  deployments: '2024-10-21',
  v1: null,
  models: '2024-05-01-preview',
}

export interface ParsedEndpoint {
  /** Scheme and host only, e.g. https://res.openai.azure.com */
  base: string
  style?: EndpointStyle
  deployment?: string
  apiVersion?: string
}

/** Reads whatever the user pasted: a bare resource URL or a full request URL from the portal. */
export function parseEndpoint(input: string): ParsedEndpoint | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  const parsed: ParsedEndpoint = { base: `https://${url.host}` }
  const apiVersion = url.searchParams.get('api-version')
  if (apiVersion) parsed.apiVersion = apiVersion
  const path = url.pathname.replace(/\/+$/, '')
  const deployment = path.match(/^\/openai\/deployments\/([^/]+)/)
  if (deployment) {
    parsed.style = 'deployments'
    parsed.deployment = decodeURIComponent(deployment[1])
  } else if (path.startsWith('/openai/v1')) {
    parsed.style = 'v1'
  } else if (path.startsWith('/models')) {
    parsed.style = 'models'
  } else {
    parsed.style = guessStyle(url.host)
  }
  return parsed
}

export function guessStyle(host: string): EndpointStyle | undefined {
  if (host.endsWith('.openai.azure.com')) return 'deployments'
  if (host.endsWith('.services.ai.azure.com')) return 'models'
  return undefined
}

export interface ResolvedEndpoint {
  url: string
  /** Sent as `model` in the body for styles that route by body rather than path. */
  model?: string
}

export function chatUrl(base: string, style: EndpointStyle, deployment: string, apiVersion?: string): ResolvedEndpoint {
  return requestUrl(base, style, deployment, 'chat/completions', apiVersion)
}

export function requestUrl(
  base: string,
  style: EndpointStyle,
  deployment: string,
  operation: string,
  apiVersion?: string,
): ResolvedEndpoint {
  const version = apiVersion || DEFAULT_API_VERSION[style]
  const query = version ? `?api-version=${encodeURIComponent(version)}` : ''
  switch (style) {
    case 'deployments':
      return { url: `${base}/openai/deployments/${encodeURIComponent(deployment)}/${operation}${query}` }
    case 'v1':
      return { url: `${base}/openai/v1/${operation}`, model: deployment }
    case 'models':
      return { url: `${base}/models/${operation}${query}`, model: deployment }
  }
}
