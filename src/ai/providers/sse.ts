/**
 * Reads a server-sent events body and yields each `data:` payload. Handles events split
 * across chunks and multi-line data fields; stops at the OpenAI-style `[DONE]` sentinel.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let boundary: number
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        if (data === '[DONE]') return
        yield data
      }
      if (done) {
        const tail = buffer.trim()
        if (tail.startsWith('data:')) {
          const data = tail.slice(5).trim()
          if (data && data !== '[DONE]') yield data
        }
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
