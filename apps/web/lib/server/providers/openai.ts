/**
 * OpenAI api_key adapter — direct Responses API.
 *
 * Endpoint: `https://api.openai.com/v1/responses`
 * Auth:     `Authorization: Bearer <api-key>`
 *
 * Differences from `providers/codex.ts` (which talks to the chatgpt.com
 * backend via OAuth):
 *
 *  - No `originator` / `chatgpt-account-id` / `User-Agent: codex-cli/*`
 *    headers — those are ChatGPT-internal.
 *  - No `attach_item_ids` reasoning anchor wrangling — the public
 *    Responses API uses canonical `previous_response_id + store: true`
 *    chaining, server-managed.
 *  - No transient socket-drop retry-with-native-off (Codex-specific
 *    chatgpt.com backend bug).
 *
 * SSE event shapes are identical, so we delegate to the shared
 * `normalizeResponsesStream` for engine-side StreamDelta normalization.
 *
 * Chain state: keyed by `chainKey ?? sessionId`. We track only
 * `lastResponseId`. After the first turn, subsequent turns send the
 * messages as-is (server-side `previous_response_id` resolves prior
 * context automatically; sending the full history alongside is a
 * no-op cost-wise because the server dedups against its stored prefix).
 */

import { loadToken } from '../tokens'
import { OpenAIResponsesCachingStrategy } from './caching'
import { redactCredentials } from './errors'
import { sseEvents, toResponsesInput, toolsToResponses } from './openai-response-shared'
import type { ChatMessage, ToolSpec } from './types'

const RESPONSES_URL = 'https://api.openai.com/v1/responses'

interface ChainState {
  lastResponseId: string | null
  /** Wallclock when the chain was last touched. Used for opportunistic
   *  cleanup of stale chains; the server enforces a 30-day TTL anyway,
   *  after which `previous_response_id` returns 400 and we fall back
   *  to a fresh request. */
  lastTouched: number
}

const globalForChain = globalThis as unknown as {
  __openhive_openai_response_chain?: Map<string, ChainState>
}

function chainStore(): Map<string, ChainState> {
  if (!globalForChain.__openhive_openai_response_chain) {
    globalForChain.__openhive_openai_response_chain = new Map()
  }
  return globalForChain.__openhive_openai_response_chain
}

function getChain(key: string | undefined): ChainState | null {
  if (!key) return null
  return chainStore().get(key) ?? null
}

function setChain(key: string, lastResponseId: string): void {
  chainStore().set(key, { lastResponseId, lastTouched: Date.now() })
}

/** Drop a chain when the engine resets reasoning (mirror of
 *  `codex.resetReasoningForChain`). Called after a delegation returns
 *  so the parent re-reasons from fresh data. */
export function resetChain(chainKey: string): void {
  chainStore().delete(chainKey)
}

/** Sweep all chains for a session on session teardown. */
export function clearOpenAIChain(sessionId: string): void {
  const m = chainStore()
  const prefix = `${sessionId}:`
  for (const k of m.keys()) {
    if (k === sessionId || k.startsWith(prefix)) m.delete(k)
  }
}

const cachingStrategy = new OpenAIResponsesCachingStrategy()

function getApiKey(): string {
  const record = loadToken('openai')
  if (!record) {
    throw new Error('OpenAI is not connected. Add an API key in Settings first.')
  }
  return record.access_token
}

export interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  /** Engine session id — used for chain-state key isolation across
   *  parallel sessions. */
  sessionId?: string
  /** Per-runNode chain key. Pass through from the engine so concurrent
   *  delegations get isolated `previous_response_id` slots. */
  chainKey?: string
  nativeWebSearch?: boolean
}

export async function* streamResponses(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const apiKey = getApiKey()
  const { system, items } = toResponsesInput(opts.messages)
  let respTools = toolsToResponses(opts.tools)
  if (opts.nativeWebSearch) {
    respTools = [...(respTools ?? []), { type: 'web_search' }]
  }
  const instructions =
    (system ?? '').trim() ||
    'You are a helpful assistant. Follow the user\'s request directly.'

  const chainKey = opts.chainKey ?? opts.sessionId
  const prior = getChain(chainKey)

  const payload = cachingStrategy.applyToRequest({
    model: opts.model,
    input: items,
    instructions,
    tools: respTools,
    previousResponseId: prior?.lastResponseId ?? null,
  })

  const timeoutMs = Number(process.env.OPENHIVE_OPENAI_TIMEOUT_MS ?? 600_000)
  const resp = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
    ),
  })
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : ''
    // Stale chain — server returned 400 because the previous_response_id
    // expired or was never stored. Drop the chain entry and surface the
    // error so the caller can retry with a fresh chain.
    if (resp.status === 400 && chainKey && prior) {
      chainStore().delete(chainKey)
    }
    throw new Error(redactCredentials(`OpenAI responses ${resp.status}: ${body}`))
  }

  for await (const ev of sseEvents(resp.body)) {
    // Capture the response id on completion so the next turn in this
    // chain can reference it via `previous_response_id`. Done here in
    // the adapter (not the normalizer) so chain-state lookup stays
    // co-located with the fetch / auth concerns.
    const newId = cachingStrategy.extractResponseId(ev)
    if (newId && chainKey) setChain(chainKey, newId)
    yield ev
  }
}
