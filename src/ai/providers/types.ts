/** Content of a chat message: plain text, or text and images (as data URLs). */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON arguments as the model produced them; validated by the caller. */
  arguments: string
}

export type ChatMessage =
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  system: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  /** 'required' forces at least one tool call; a name forces that tool. */
  toolChoice?: 'auto' | 'required' | { name: string }
  maxOutputTokens?: number
}

export interface Usage {
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: string | null
  /** The model name the service reported, when it does. */
  model?: string
}

export interface ChatProgress {
  /** Approximate output tokens received so far while streaming. */
  outputTokens: number
}

export interface ProviderCapabilities {
  vision: boolean
  tools: boolean
  streaming: boolean
  transcription: boolean
}

export interface ConnectionReport {
  model?: string
  latencyMs: number
  toolCalling: boolean
  usage: Usage
}

export interface LLMProvider {
  id: string
  label: string
  capabilities: ProviderCapabilities
  complete(req: ChatRequest, opts: { signal?: AbortSignal; onProgress?: (p: ChatProgress) => void }): Promise<ChatResult>
  /** Sends a tiny request that needs a tool call, to check the endpoint, key and deployment. */
  testConnection(signal?: AbortSignal): Promise<ConnectionReport>
}

export type ProviderErrorKind = 'config' | 'auth' | 'not-found' | 'rate-limit' | 'bad-request' | 'network' | 'server' | 'aborted'

/** A provider failure with a message written for the person using the app. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly status?: number
  readonly retryAfterMs?: number
  constructor(kind: ProviderErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = opts.status
    this.retryAfterMs = opts.retryAfterMs
  }
}
