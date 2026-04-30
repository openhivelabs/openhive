/**
 * Google Gemini api_key adapter — Google AI Studio (`generativelanguage
 * .googleapis.com`).
 *
 * Endpoint: `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`
 * Auth:     `x-goog-api-key: <api-key>` header (NOT in URL — keeps the
 *           key out of access logs even when proxies don't strip query
 *           strings)
 *
 * Most logic is shared with `providers/vertex.ts` via
 * `providers/gemini-shared.ts`. This module only handles auth + endpoint
 * URL construction.
 */

import { loadToken } from '../tokens'
import { redactCredentials } from './errors'
import {
  DEFAULT_SAFETY_SETTINGS,
  sseEventsGemini,
  thinkingConfigFor,
  toGeminiContents,
  toolsToGemini,
} from './gemini-shared'
import type { ChatMessage, ToolSpec } from './types'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

function getApiKey(): string {
  const record = loadToken('gemini')
  if (!record) {
    throw new Error('Gemini is not connected. Add an API key in Settings first.')
  }
  return record.access_token
}

export interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  sessionId?: string
  chainKey?: string
  nativeWebSearch?: boolean
  /** Reasoning effort — maps onto `thinkingLevel` (Gemini 3.x) or
   *  `thinkingBudget` (Gemini 2.5). Default 'medium'. */
  effort?: 'low' | 'medium' | 'high'
  temperature?: number
  maxOutputTokens?: number
}

export async function* streamGenerateContent(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const apiKey = getApiKey()
  const chainKey = opts.chainKey ?? opts.sessionId
  const { systemInstruction, contents } = toGeminiContents(opts.messages, chainKey)

  const tools: unknown[] = []
  const fnDecls = toolsToGemini(opts.tools)
  if (fnDecls) tools.push(fnDecls)
  if (opts.nativeWebSearch) tools.push({ googleSearch: {} })

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      thinkingConfig: thinkingConfigFor(opts.model, opts.effort ?? 'medium'),
      ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
      ...(typeof opts.maxOutputTokens === 'number' ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
    safetySettings: DEFAULT_SAFETY_SETTINGS,
  }
  if (systemInstruction) body.systemInstruction = systemInstruction
  if (tools.length > 0) body.tools = tools

  const url = `${BASE_URL}/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`
  const timeoutMs = Number(process.env.OPENHIVE_GEMINI_TIMEOUT_MS ?? 600_000)
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
    ),
  })
  if (!resp.ok || !resp.body) {
    const text = resp.body ? await resp.text() : ''
    throw new Error(redactCredentials(`Gemini ${resp.status}: ${text}`))
  }

  yield* sseEventsGemini(resp.body)
}
