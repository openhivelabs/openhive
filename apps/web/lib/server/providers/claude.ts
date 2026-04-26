/**
 * Claude Code — Anthropic Messages API via OAuth access token.
 * Ports apps/server/openhive/proxy/claude.py.
 *
 * Single-stage auth:
 *   - OAuth access_token + refresh_token live in oauth_tokens.
 *   - Used directly against /v1/messages with OAuth beta headers.
 *   - We refresh when expires_at is within 60s of now.
 *
 * Messages/tools arrive in OpenAI shape (engine's canonical form) and are
 * translated to Anthropic content-block shape on the way out; tool_result
 * blocks ride on a synthetic `user` role, matching Anthropic's protocol.
 */

import { CLIENT_ID } from '../auth/claude'
import { getAccountLabel, loadToken, saveToken } from '../tokens'
import { AnthropicCachingStrategy } from './caching'
import type { ChatMessage, ToolCall, ToolSpec } from './types'

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages?beta=true'
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'

const ANTHROPIC_BETA = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'structured-outputs-2025-12-15',
  'fast-mode-2026-02-01',
  'redact-thinking-2026-02-12',
  'token-efficient-tools-2026-03-28',
  // Enable Anthropic's hosted server-side web search tool. Harmless when
  // no `web_search_20250305` tool is attached to a request — it only
  // activates when the agent opts in via `nativeWebSearch`. See
  // `apps/web/scripts/probe-native-web-search.ts` for the live probe.
  'web-search-2025-03-05',
].join(',')

const ANTHROPIC_HEADERS: Record<string, string> = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': ANTHROPIC_BETA,
  'anthropic-dangerous-direct-browser-access': 'true',
  'Content-Type': 'application/json',
}

interface CachedAuth {
  accessToken: string
  expiresAt: number
}

const globalForAuth = globalThis as unknown as {
  __openhive_claude_auth?: Map<string, CachedAuth>
}

function authCache(): Map<string, CachedAuth> {
  if (!globalForAuth.__openhive_claude_auth) {
    globalForAuth.__openhive_claude_auth = new Map()
  }
  return globalForAuth.__openhive_claude_auth
}

async function refreshAccess(
  providerId: string,
  refreshToken: string,
): Promise<CachedAuth> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `Claude refresh failed (${resp.status}): ${await resp.text()}`,
    )
  }
  const data = (await resp.json()) as Record<string, unknown>
  const access = String(data.access_token ?? '')
  const newRefresh =
    typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken
  const expiresIn = Number(data.expires_in ?? 3600)
  const expiresAt = Date.now() / 1000 + expiresIn
  saveToken({
    provider_id: providerId,
    access_token: access,
    refresh_token: newRefresh,
    expires_at: Math.floor(expiresAt),
    scope: typeof data.scope === 'string' ? data.scope : null,
    account_label: getAccountLabel(providerId),
    account_id: null,
  })
  const cached: CachedAuth = { accessToken: access, expiresAt }
  authCache().set(providerId, cached)
  return cached
}

async function getAccessToken(providerId = 'claude-code'): Promise<string> {
  const now = Date.now() / 1000
  const hit = authCache().get(providerId)
  if (hit && hit.expiresAt - 60 > now) return hit.accessToken
  const record = loadToken(providerId)
  if (!record) {
    throw new Error('Claude Code is not connected. Connect it in Settings first.')
  }
  if (record.expires_at && record.expires_at - 60 > now) {
    const cached: CachedAuth = {
      accessToken: record.access_token,
      expiresAt: record.expires_at,
    }
    authCache().set(providerId, cached)
    return cached.accessToken
  }
  if (!record.refresh_token) {
    // No refresh token — use whatever we have and hope it still works.
    return record.access_token
  }
  const refreshed = await refreshAccess(providerId, record.refresh_token)
  return refreshed.accessToken
}

// -------- format translation --------

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: string
  content: string | AnthropicBlock[]
}

const cachingStrategy = new AnthropicCachingStrategy()

function splitSystem(
  messages: ChatMessage[],
): { system: string | null; out: AnthropicMessage[] } {
  let system: string | null = null
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? `${system}\n\n` : '') + (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: typeof m.content === 'string' ? m.content : '',
          },
        ],
      })
      continue
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (typeof m.content === 'string' && m.content) {
        blocks.push({ type: 'text', text: m.content })
      }
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
        } catch {
          args = {}
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: args,
        })
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content: blocks })
      continue
    }
    out.push({ role: m.role ?? 'user', content: typeof m.content === 'string' ? m.content : '' })
  }
  return { system, out: mergeAdjacentUsers(out) }
}

/**
 * Merge consecutive `role: 'user'` messages into a single block-array message.
 * Fork children produce adjacent `user` messages (synthetic tool_result +
 * directive) — Anthropic requires alternating roles, and even if accepted, the
 * combine step ensures byte-identical prefix across siblings. For the non-fork
 * path this is a no-op (no adjacent user messages are produced).
 */
export function mergeAdjacentUsers(out: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = []
  for (const m of out) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === 'user' && m.role === 'user') {
      const prevBlocks: AnthropicBlock[] = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text', text: String(prev.content ?? '') }]
      const curBlocks: AnthropicBlock[] = Array.isArray(m.content)
        ? m.content
        : [{ type: 'text', text: String(m.content ?? '') }]
      prev.content = [...prevBlocks, ...curBlocks]
    } else {
      merged.push(m)
    }
  }
  return merged
}

// -------- streaming --------

/** Parse a text/event-stream body into discrete SSE `data:` JSON events. */
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
  maxTokens?: number
  /** S3 fork: skip any tool-order optimization so sibling payloads stay
   *  byte-identical for Anthropic prompt-cache hit. Currently a sentinel —
   *  `AnthropicCachingStrategy` already preserves input order. */
  useExactTools?: boolean
  /** S3 fork: replace `splitSystem`-derived system with this exact string.
   *  Any `role: 'system'` messages are stripped before splitting so they
   *  cannot double-inject. */
  overrideSystem?: string
  /** Expose Anthropic's server-side `web_search_20250305` builtin tool.
   *  When true, appends a hosted web_search tool (name=`web_search`,
   *  max_uses=5) to the Messages API request. The model integrates
   *  results directly into its assistant turn (no extra round-trip on
   *  our side). When this errors out (rate-limited, scope blocked,
   *  etc.) the model can still call our function-shaped `web-search`
   *  skill as a fallback. */
  nativeWebSearch?: boolean
}

export async function* streamMessages(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const providerId = opts.providerId ?? 'claude-code'
  const access = await getAccessToken(providerId)
  const messagesForSplit = opts.overrideSystem
    ? opts.messages.filter((m) => m.role !== 'system')
    : opts.messages
  const { system, out } = splitSystem(messagesForSplit)
  const finalSystem = opts.overrideSystem ?? system

  // Caching strategy owns the payload shape — cache_control markers on
  // (system, tools[last], messages[last]) land here without touching
  // the stream loop below.
  const payload = cachingStrategy.applyToRequest({
    system: finalSystem,
    messages: out,
    tools: opts.tools && opts.tools.length > 0 ? opts.tools : null,
    model: opts.model,
    maxTokens: opts.maxTokens ?? 4096,
    useExactTools: opts.useExactTools,
  })

  // Inject Anthropic's hosted `web_search_20250305` builtin alongside the
  // function-shaped tools the caching strategy already mapped. Must run
  // after the strategy because the strategy iterates `req.tools` (OpenAI
  // shape) — the hosted tool has a different shape and isn't part of the
  // engine's ToolSpec set. `max_uses` caps the model at 5 searches per
  // turn (cheap insurance; Anthropic also enforces account-level limits).
  if (opts.nativeWebSearch) {
    const list = (payload as { tools?: unknown[] }).tools ?? []
    list.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    })
    ;(payload as { tools?: unknown[] }).tools = list
  }

  // Anthropic returns 429 with `x-should-retry: true` and no rate-limit
  // detail headers when the per-minute input-token rate is tripped (large
  // prompts in close succession). Auto-retry with exponential backoff:
  // attempt 1 = immediate, attempt 2 after ~6s, attempt 3 after ~18s.
  // Total wait ≤ 30s. Beyond that, the burst is over and bubbling the
  // error up gives the caller a chance to surface it. 5xx are treated
  // the same — Anthropic's transient error class.
  let resp: Response
  let attempt = 0
  while (true) {
    resp = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        ...ANTHROPIC_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    })
    const retriable =
      resp.status === 429 ||
      resp.status === 529 ||
      (resp.status >= 500 && resp.status <= 599)
    if (resp.ok || !retriable || attempt >= 2) break
    // Drain body (avoid socket leak), then back off.
    try { await resp.text() } catch { /* ignore */ }
    attempt += 1
    const waitMs = 6000 * attempt + Math.floor(Math.random() * 2000)
    await new Promise((r) => setTimeout(r, waitMs))
  }
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : ''
    throw new Error(`Claude messages stream ${resp.status}: ${body}`)
  }
  yield* sseEvents(resp.body)
}

/** For engine typing — re-exports the OpenAI-shaped ToolCall type. */
export type { ToolCall }
