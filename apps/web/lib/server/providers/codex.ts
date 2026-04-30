/**
 * OpenAI Codex — ChatGPT backend-api Responses endpoint via OAuth.
 * Ports apps/server/openhive/proxy/codex.py.
 *
 * Flow:
 *   - OAuth access_token + refresh_token + chatgpt_account_id in oauth_tokens.
 *   - Refresh via https://auth.openai.com/oauth/token on 60s skew.
 *   - Stream via https://chatgpt.com/backend-api/codex/responses with
 *     OpenAI-Beta: responses=experimental.
 *
 * Messages arrive in the engine's OpenAI-Chat canonical shape and are
 * translated to the Responses API's `instructions` + `input[]` items.
 */

import crypto from 'node:crypto'
import { CLIENT_ID } from '../auth/codex'
import { getAccountLabel, loadToken, saveToken } from '../tokens'
import { CodexCachingStrategy } from './caching'
import { redactCredentials } from './errors'
import {
  type ResponseInputItem,
  sseEvents,
  toResponsesInput,
  toolsToResponses,
} from './openai-response-shared'
import type { ChatMessage, ToolSpec } from './types'

const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'

interface Session {
  accessToken: string
  accountId: string | null
  expiresAt: number
}

const globalForCache = globalThis as unknown as {
  __openhive_codex_session?: Map<string, Session>
}

function cache(): Map<string, Session> {
  if (!globalForCache.__openhive_codex_session) {
    globalForCache.__openhive_codex_session = new Map()
  }
  return globalForCache.__openhive_codex_session
}

/** Drop the cached session for `providerId` so a fresh OAuth token isn't
 *  shadowed by a stale entry. */
export function clearCodexSessionCache(providerId = 'codex'): void {
  cache().delete(providerId)
}

function decodeJwt(t: string): Record<string, unknown> {
  try {
    const parts = t.split('.')
    if (parts.length < 2) return {}
    const payload = parts[1]!
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const decoded = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function refresh(
  providerId: string,
  refreshToken: string,
): Promise<Session> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
    scope: 'openid profile email offline_access',
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      redactCredentials(`Codex refresh failed (${resp.status}): ${await resp.text()}`),
    )
  }
  const data = (await resp.json()) as Record<string, unknown>
  const access = String(data.access_token ?? '')
  const newRefresh =
    typeof data.refresh_token === 'string' ? data.refresh_token : refreshToken
  const expiresAt = Date.now() / 1000 + Number(data.expires_in ?? 3600)
  const claims = decodeJwt(
    typeof data.id_token === 'string' ? data.id_token : '',
  )
  const oaiAuth = claims['https://api.openai.com/auth']
  let accountId: string | null = null
  if (oaiAuth && typeof oaiAuth === 'object') {
    const v = (oaiAuth as Record<string, unknown>).chatgpt_account_id
    if (typeof v === 'string') accountId = v
  }
  if (!accountId && typeof claims.chatgpt_account_id === 'string') {
    accountId = claims.chatgpt_account_id
  }
  if (!accountId) {
    const existing = loadToken(providerId)
    accountId = existing?.account_id ?? null
  }
  saveToken({
    provider_id: providerId,
    access_token: access,
    refresh_token: newRefresh,
    expires_at: Math.floor(expiresAt),
    scope: typeof data.scope === 'string' ? data.scope : null,
    account_label:
      getAccountLabel(providerId) ??
      (typeof claims.email === 'string' ? claims.email : null),
    account_id: accountId,
  })
  const sess: Session = { accessToken: access, accountId, expiresAt }
  cache().set(providerId, sess)
  return sess
}

async function getSession(providerId = 'codex'): Promise<Session> {
  const now = Date.now() / 1000
  const hit = cache().get(providerId)
  if (hit && hit.expiresAt - 60 > now && hit.accountId) return hit
  const record = loadToken(providerId)
  if (!record) {
    throw new Error('Codex is not connected. Connect it in Settings first.')
  }
  if (
    record.expires_at &&
    record.expires_at - 60 > now &&
    record.account_id
  ) {
    const sess: Session = {
      accessToken: record.access_token,
      accountId: record.account_id,
      expiresAt: record.expires_at,
    }
    cache().set(providerId, sess)
    return sess
  }
  if (!record.refresh_token) {
    return {
      accessToken: record.access_token,
      accountId: record.account_id,
      expiresAt: now + 300,
    }
  }
  return refresh(providerId, record.refresh_token)
}

// `toResponsesInput`, `toolsToResponses`, `sseEvents`, `ResponseInputItem`
// are now exported from `./openai-response-shared.ts` so the OpenAI api_key
// adapter (`./openai.ts`) can reuse them. The Responses API wire shape is
// identical between the chatgpt.com Codex backend and the public
// `api.openai.com/v1/responses` endpoint, so the translation helpers are
// genuinely shared.

interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  providerId?: string
  /** Session key used to isolate per-chat prior-item buffers across
   *  concurrent sessions. Without it, parallel chats would share one
   *  global slot and clobber each other's reasoning anchors. */
  sessionId?: string
  /** Per-agent chain key. Within a single engine session, multiple
   *  concurrent streams (e.g. parallel `delegate_parallel` siblings, or
   *  any time two codex agents in the same session run at once) MUST
   *  NOT share reasoning/function-call anchors — sibling A's reasoning
   *  IDs spliced into sibling B's request makes the ChatGPT backend
   *  drop the socket mid-stream (`TypeError: terminated`). The engine
   *  mints one chainKey per `runNode` invocation so rounds within a
   *  single agent's turn-loop share state but separate agents never do.
   *  Falls back to `sessionId` for legacy callers. Convention:
   *  `${sessionId}:<random>` so `clearCodexChain(sessionId)` can sweep
   *  every chain belonging to a session by prefix on session exit. */
  chainKey?: string
  /** Expose Codex's server-side `web_search` builtin tool. When true,
   *  appends `{type: "web_search"}` to the Responses API tools array so
   *  the model can run searches on the ChatGPT backend's own infra
   *  (no scraping, no IP block, no captcha). The model integrates
   *  results directly into its output text — no extra round-trip on
   *  our side. The matching `response.web_search_call.*` SSE events
   *  are observable but not surfaced as engine tool_calls (they're
   *  hosted-side, not function calls). Verified accepted by Codex
   *  backend 2026-04-26 via `apps/web/scripts/probe-native-web-search.ts`. */
  nativeWebSearch?: boolean
}

const cachingStrategy = new CodexCachingStrategy()

/**
 * attach_item_ids — mirror OpenAI Codex CLI's multi-round strategy.
 *
 * gpt-5 / gpt-5.5 are reasoning models that return empty `response.output`
 * on follow-up rounds unless their prior reasoning items are re-presented
 * to them with server-assigned IDs (reference:
 * `codex-rs/codex-api/src/requests/responses.rs::attach_item_ids`).
 *
 * Approach:
 *   - Buffer the reasoning items the server emits in each response
 *     (extracted from `response.output_item.done` SSE events).
 *   - Buffer the server-assigned `id` for every `function_call` item,
 *     keyed by the call_id we generated client-side.
 *   - On the NEXT request: translate history to items as usual, then
 *     overlay the server ids onto any `function_call` items whose
 *     call_id we have on file, and splice the buffered reasoning
 *     items into the items array right BEFORE the first
 *     `function_call` / `function_call_output` so the chronological
 *     shape matches what the server originally emitted.
 *
 * Do NOT use `previous_response_id` + `store: true` — those do not
 * restore reasoning state reliably on the chatgpt.com/backend-api
 * endpoint. `attach_item_ids` is the only pattern known to work.
 *
 * State is keyed by sessionId so parallel chat sessions don't stomp
 * each other. Session exit clears the entry via `clearCodexChain`.
 */
interface CodexSessionState {
  /** reasoning items from the MOST RECENT `response.completed`.
   *  Replaced on each complete, so we only carry what the model last
   *  emitted — older reasonings become dead weight after a new one
   *  supersedes them. */
  lastReasonings: ResponseInputItem[]
  /** server-assigned ids for function_call items, keyed by our
   *  client-side call_id. Accumulates — on multi-turn sessions the
   *  model may reference calls from earlier turns. */
  funcItemIds: Map<string, string>
}

const globalForState = globalThis as unknown as {
  __openhive_codex_session_state?: Map<string, CodexSessionState>
}

function stateMap(): Map<string, CodexSessionState> {
  if (!globalForState.__openhive_codex_session_state) {
    globalForState.__openhive_codex_session_state = new Map()
  }
  return globalForState.__openhive_codex_session_state
}

function chainStateKey(key: string | undefined): string {
  return key && key.length > 0 ? key : '__default__'
}

function getState(key: string | undefined): CodexSessionState {
  const k = chainStateKey(key)
  let s = stateMap().get(k)
  if (!s) {
    s = { lastReasonings: [], funcItemIds: new Map() }
    stateMap().set(k, s)
  }
  return s
}

/** Drop only the reasoning anchors for one chain, preserving function-call
 *  id mappings. Use when an agent has just received a delegation result
 *  and we want it to re-reason from the tool_result instead of letting
 *  its prior round's reasoning items (which encoded its training-prior
 *  beliefs about the topic) get re-spliced into the next request and
 *  override the fresh data. Without this, gpt-5.5 reliably ignores the
 *  delegation report and regurgitates its training memory. */
export function resetReasoningForChain(chainKey: string): void {
  const k = chainStateKey(chainKey)
  const s = stateMap().get(k)
  if (s) s.lastReasonings = []
}

/** Drop a session's attach-items state — call when a session ends so we
 *  don't leak entries indefinitely. Safe to call for unknown sessions.
 *
 *  Sweeps every chain whose key starts with `${sessionId}:` (the engine
 *  mints chainKeys as `${sessionId}:<random>` per runNode), plus the
 *  bare `sessionId` entry for legacy single-chain callers. */
export function clearCodexChain(sessionId: string): void {
  const map = stateMap()
  map.delete(sessionId)
  const prefix = `${sessionId}:`
  for (const k of [...map.keys()]) {
    if (k.startsWith(prefix)) map.delete(k)
  }
}

/** Test-only: peek into internal chain state for the given key. Never
 *  call from production code — the shape and lifetime of the state is
 *  an implementation detail of the codex adapter. */
export const __test = {
  getState,
  stateMap,
  chainStateKey,
}

/** Apply the attach-items overlay + reasoning splice to a translated
 *  items array, producing the final `input` for a Responses-API call. */
function applyAttachItemIds(
  items: ResponseInputItem[],
  state: CodexSessionState,
): ResponseInputItem[] {
  if (state.lastReasonings.length === 0 && state.funcItemIds.size === 0) {
    return items
  }
  // Overlay server ids onto function_call items.
  const overlaid = items.map((it) => {
    if (it.type === 'function_call' && it.call_id) {
      const id = state.funcItemIds.get(it.call_id)
      if (id && !it.id) return { ...it, id }
    }
    return it
  })
  // Splice reasoning items right BEFORE the first function_call /
  // function_call_output so chronological shape matches the server's
  // original emission order: [user, reasoning, fc_*, fco_*, ...].
  if (state.lastReasonings.length === 0) return overlaid
  let insertAt = overlaid.length
  for (let i = 0; i < overlaid.length; i++) {
    const t = overlaid[i]!.type
    if (t === 'function_call' || t === 'function_call_output') {
      insertAt = i
      break
    }
  }
  return [
    ...overlaid.slice(0, insertAt),
    ...state.lastReasonings,
    ...overlaid.slice(insertAt),
  ]
}

export async function* streamResponses(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  // The codex/chatgpt backend intermittently drops the SSE socket mid-
  // `web_search` (`TypeError: terminated`), even on solo non-concurrent
  // calls. The model has produced no useful text by that point — only
  // observability lifecycle events (`response.web_search_call.in_progress`
  // / `searching`). Retry once with the native web_search tool disabled:
  // the model falls back to the function-shaped `web-search` skill (still
  // registered) and the request completes normally. Without this, a
  // single Member node failing here pushes the whole turn into placeholder-
  // hallucinate territory at the parent.
  let attempt = 0
  while (true) {
    try {
      yield* streamResponsesOnce(opts)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const transient = /terminated|fetch failed|socket hang up|ECONNRESET/i.test(msg)
      if (transient && attempt < 1 && opts.nativeWebSearch) {
        attempt += 1
        opts = { ...opts, nativeWebSearch: false }
        continue
      }
      throw err
    }
  }
}

async function* streamResponsesOnce(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const providerId = opts.providerId ?? 'codex'
  const session = await getSession(providerId)
  const { system, items } = toResponsesInput(opts.messages)
  let respTools = toolsToResponses(opts.tools)
  // Inject Codex's hosted `web_search` builtin alongside our function
  // tools. The model picks: native for typical search needs (faster,
  // captcha-immune, runs on the provider's infra), our `web-search`
  // function tool as a fallback when native errors out or for queries
  // outside its policy. Position matters less than presence — Codex
  // accepts builtin and function tools in any order.
  if (opts.nativeWebSearch) {
    respTools = [...(respTools ?? []), { type: 'web_search' }]
  }

  const instructions =
    (system ?? '').trim() ||
    "You are Codex, a helpful coding assistant. Follow the user's request directly."

  const state = getState(opts.chainKey ?? opts.sessionId)
  const inputItems = applyAttachItemIds(items, state)

  const payload = cachingStrategy.applyToRequest({
    model: opts.model,
    input: inputItems,
    instructions,
    tools: respTools,
  })

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    'User-Agent': 'codex-cli/1.0.18 (macOS; arm64)',
    session_id: crypto.randomUUID(),
  }
  if (session.accountId) headers['chatgpt-account-id'] = session.accountId

  // AbortSignal.timeout applies to the ENTIRE fetch lifetime, including body
  // streaming — so a long synthesis response (Lead assembling a final answer
  // across many tokens) that exceeds this hardcap is killed mid-stream with
  // "operation was aborted due to timeout" and the whole run errors out.
  // 600s default gives Lead headroom for multi-paragraph comparative reports;
  // tunable via env for slower networks or even larger syntheses.
  const timeoutMs = Number(process.env.OPENHIVE_CODEX_TIMEOUT_MS ?? 600_000)
  const resp = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
    ),
  })
  if (!resp.ok || !resp.body) {
    const body = resp.body ? await resp.text() : ''
    throw new Error(redactCredentials(`Codex responses ${resp.status}: ${body}`))
  }

  // Scratch capture: reasonings + function_call id mappings accrued during
  // THIS response. Committed to session state only on `response.completed`
  // so a mid-stream failure doesn't leave partial anchors that would
  // poison the next round.
  const scratchReasonings: ResponseInputItem[] = []
  const scratchFuncIds = new Map<string, string>()

  for await (const ev of sseEvents(resp.body)) {
    const type = (ev as { type?: string }).type
    if (type === 'response.output_item.done') {
      const item = ((ev as { item?: Record<string, unknown> }).item ?? {}) as Record<string, unknown>
      const itemType = typeof item.type === 'string' ? item.type : ''
      if (itemType === 'reasoning' && typeof item.id === 'string') {
        // Preserve the full raw shape so we can re-submit it verbatim.
        const preserved: ResponseInputItem = {
          type: 'reasoning',
          id: item.id,
        }
        if (typeof item.encrypted_content === 'string') {
          preserved.encrypted_content = item.encrypted_content
        }
        if (item.summary !== undefined) preserved.summary = item.summary
        scratchReasonings.push(preserved)
      } else if (itemType === 'function_call') {
        const id = typeof item.id === 'string' ? item.id : ''
        const callId = typeof item.call_id === 'string' ? item.call_id : ''
        if (id && callId) scratchFuncIds.set(callId, id)
      }
    } else if (type === 'response.completed') {
      // Commit anchors: replace reasonings (only the most recent matter),
      // merge function-call ids (accumulate across turns).
      state.lastReasonings = scratchReasonings
      for (const [k, v] of scratchFuncIds) state.funcItemIds.set(k, v)
    }
    yield ev
  }
}
