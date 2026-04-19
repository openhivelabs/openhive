export interface ChatStreamRequest {
  provider: string
  model: string
  system?: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
}

/**
 * Streams tokens from POST /api/test/chat/stream as an async iterator of deltas.
 * Throws if the server returns an error frame or a non-2xx response.
 */
export async function* streamChat(
  req: ChatStreamRequest,
  signal?: AbortSignal,
): AsyncIterator<string> {
  const res = await fetch('/api/test/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`stream failed (${res.status}): ${body}`)
  }
  if (!res.body) throw new Error('no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const frames = buf.split('\n\n')
    buf = frames.pop() ?? ''
    for (const frame of frames) {
      if (!frame.startsWith('data: ')) continue
      const payload = frame.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload) as { delta?: string; error?: string }
        if (obj.error) throw new Error(obj.error)
        if (obj.delta) yield obj.delta
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('stream')) throw e
        // otherwise swallow unparseable frames
      }
    }
  }
}
