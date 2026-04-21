/**
 * GitHub Copilot — OpenAI-compatible chat/completions.
 * Ports the streaming half of apps/server/openhive/proxy/copilot.py
 * (the session cache + /models fetch live in copilot-session.ts).
 *
 * Payload shape is identical to OpenAI, minus role-field quirks: Copilot
 * accepts the engine's canonical messages verbatim.
 */

import { NoopCachingStrategy } from './caching'
import { EDITOR_HEADERS, getCopilotSession } from './copilot-session'
import type { ChatMessage, ToolSpec } from './types'

const cachingStrategy = new NoopCachingStrategy()

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      if (raw === '[DONE]') return
      try {
        yield JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* skip malformed chunks */
      }
    }
  }
}

export interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  providerId?: string
  temperature?: number
}

export async function* streamChat(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const providerId = opts.providerId ?? 'copilot'
  const session = await getCopilotSession(providerId)
  const api = session.endpoints.api ?? 'https://api.githubcopilot.com'
  const payload = cachingStrategy.applyToRequest({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools && opts.tools.length > 0 ? opts.tools : null,
    temperature: opts.temperature ?? 0.7,
  })
  const resp = await fetch(`${api}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...EDITOR_HEADERS,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : ''
    throw new Error(`Copilot stream ${resp.status}: ${body}`)
  }
  yield* sseEvents(resp.body)
}

/** Non-streaming chat completion — returns the assistant's final content. */
export async function chatCompletion(
  opts: Omit<StreamOpts, 'tools'>,
): Promise<string> {
  const providerId = opts.providerId ?? 'copilot'
  const session = await getCopilotSession(providerId)
  const api = session.endpoints.api ?? 'https://api.githubcopilot.com'
  const resp = await fetch(`${api}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      ...EDITOR_HEADERS,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!resp.ok) {
    throw new Error(`Copilot chat failed (${resp.status}): ${await resp.text()}`)
  }
  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return data.choices?.[0]?.message?.content ?? ''
}
