/**
 * Provider caching strategies (spec: docs/superpowers/specs/2026-04-22-caching-strategy.md).
 *
 * Three implementations land here:
 *
 *  - AnthropicCachingStrategy — extracted from claude.ts's in-place
 *    cache_control logic. Output is byte-equivalent to the pre-refactor
 *    payload: 3 `cache_control: { type: 'ephemeral' }` breakpoints on
 *    (tools[last], system[0], last conversation message[last block]).
 *
 *  - CodexCachingStrategy — the Responses-API chaining hook.
 *    `applyToRequest` attaches `previous_response_id` when one is
 *    provided, and flips `store: true` to opt in to server-side prefix
 *    retention. `extractResponseId` pulls the id from stream events or
 *    the final envelope so the caller can chain the next turn.
 *
 *  - NoopCachingStrategy — passthrough for Copilot.
 *
 * None of these carry session state themselves. Single-slot / per-session
 * last-response-id storage lives in the provider module that uses them
 * (see codex.ts), so the engine never has to know about chaining.
 */

import type { ChatMessage, CachingStrategy, ToolSpec } from './types'

// ---------- Anthropic ----------

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicMessage {
  role: string
  content: string | AnthropicBlock[]
}

interface AnthropicRequest {
  system: string | null
  messages: AnthropicMessage[]
  tools: ToolSpec[] | null
  model: string
  maxTokens: number
  /** S3 fork sentinel — reserved for future reorder guards. Currently
   *  inert: the strategy already preserves input order. */
  useExactTools?: boolean
  /** Cache lifetime for the ephemeral breakpoints. `'5m'` is the
   *  Anthropic default (since 2026-03-06 — silently dropped from the
   *  prior 1h default); `'1h'` opts into the longer TTL at 2x write
   *  cost. Use for long-idle agents (db_exec heavy trajectories,
   *  sessions that get re-attached after >5min idle). */
  cacheTtl?: '5m' | '1h'
}

interface AnthropicPayload {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream: true
  system?: unknown
  tools?: unknown[]
}

/**
 * Emits the exact payload shape claude.ts used before extraction.
 * Regression test lives in caching.test.ts (snapshot comparison).
 */
export class AnthropicCachingStrategy
  implements CachingStrategy<AnthropicRequest, AnthropicPayload>
{
  applyToRequest(req: AnthropicRequest): AnthropicPayload {
    const payload: AnthropicPayload = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      stream: true,
    }

    // Resolve TTL: explicit `req.cacheTtl` wins, else env default.
    // `OPENHIVE_ANTHROPIC_CACHE_TTL=1h` flips every Anthropic request
    // to the 1-hour breakpoint without touching call sites — useful
    // for operators with long-idle workloads.
    const envTtl = process.env.OPENHIVE_ANTHROPIC_CACHE_TTL?.trim()
    const ttl: '5m' | '1h' =
      req.cacheTtl ?? (envTtl === '1h' ? '1h' : '5m')
    const cacheControl: Record<string, unknown> =
      ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }

    if (req.system) {
      // Single ephemeral marker on system caches persona + team outline +
      // relay rules + skill index across turns.
      payload.system = [
        { type: 'text', text: req.system, cache_control: cacheControl },
      ]
    }

    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((t, i) => {
        const block: Record<string, unknown> = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters ?? { type: 'object', properties: {} },
        }
        // Last-tool marker caches the full tools + system prefix.
        if (i === req.tools!.length - 1) {
          block.cache_control = cacheControl
        }
        return block
      })
    }

    // Last conversation message marker — next turn's prefix through this
    // message is identical, so our cache write becomes the next read.
    // Anthropic allows 4 breakpoints; we use tools + system + last = 3.
    if (payload.messages.length > 0) {
      const last = payload.messages[payload.messages.length - 1]!
      if (typeof last.content === 'string') {
        last.content = [
          {
            type: 'text',
            text: last.content,
            cache_control: cacheControl,
          } as AnthropicBlock & { cache_control: Record<string, unknown> },
        ]
      } else if (Array.isArray(last.content) && last.content.length > 0) {
        const tail = last.content[last.content.length - 1]!
        ;(tail as AnthropicBlock & { cache_control?: unknown }).cache_control = cacheControl
      }
    }

    return payload
  }
}

// ---------- Codex ----------

interface CodexRequest {
  instructions: string
  input: unknown[]
  tools: unknown[] | null
  model: string
}

interface CodexPayload {
  model: string
  input: unknown[]
  instructions: string
  stream: true
  store: false
  parallel_tool_calls: true
  reasoning: { effort: string; summary: string }
  include: string[]
  tools?: unknown[]
  tool_choice?: string
}

/**
 * Responses-API payload builder for Codex. We use the `attach_item_ids`
 * strategy (see providers/codex.ts) to persist reasoning state across
 * rounds, NOT `previous_response_id` + `store: true` — that approach does
 * not restore reasoning items reliably on the chatgpt.com/backend-api
 * endpoint, causing gpt-5/5.5 to return empty `response.output` on round 2.
 *
 * Consequence: `store` is always `false` and we never set
 * `previous_response_id`. The caller prepends the buffered reasoning +
 * function_call anchor items directly into `input`.
 */
export class CodexCachingStrategy
  implements CachingStrategy<CodexRequest, CodexPayload>
{
  applyToRequest(req: CodexRequest): CodexPayload {
    const payload: CodexPayload = {
      model: req.model,
      input: req.input,
      instructions: req.instructions,
      stream: true,
      store: false,
      parallel_tool_calls: true,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    }
    if (req.tools) {
      payload.tools = req.tools
      payload.tool_choice = 'auto'
    }
    return payload
  }
}

// ---------- OpenAI api_key (Responses API direct) ----------

interface OpenAIResponsesRequest {
  instructions: string
  input: unknown[]
  tools: unknown[] | null
  model: string
  /** When set, server resumes from this prior response (server-side
   *  conversation state). On first turn this is null. */
  previousResponseId?: string | null
}

interface OpenAIResponsesPayload {
  model: string
  input: unknown[]
  instructions: string
  stream: true
  /** Required for `previous_response_id` to work; opts the response
   *  envelope into the 30-day server-side store. Setting this `false`
   *  silently disables chain continuity, so we always set `true` for
   *  this strategy and accept the data-retention trade-off. */
  store: true
  parallel_tool_calls: true
  reasoning: { effort: string; summary: string }
  include: string[]
  tools?: unknown[]
  tool_choice?: string
  previous_response_id?: string
}

/**
 * Payload builder for the public OpenAI Responses API (`api.openai.com
 * /v1/responses`). Differences from `CodexCachingStrategy`:
 *
 *  - Uses the canonical `previous_response_id + store: true` chain
 *    (Codex falls back to `attach_item_ids` because chatgpt.com/backend
 *    -api doesn't store responses reliably).
 *  - Caller manages a per-`chainKey` Map of `lastResponseId` and only
 *    sends incremental input items after the first turn — see
 *    `providers/openai.ts:streamResponses`.
 */
export class OpenAIResponsesCachingStrategy
  implements CachingStrategy<OpenAIResponsesRequest, OpenAIResponsesPayload>
{
  applyToRequest(req: OpenAIResponsesRequest): OpenAIResponsesPayload {
    const payload: OpenAIResponsesPayload = {
      model: req.model,
      input: req.input,
      instructions: req.instructions,
      stream: true,
      store: true,
      parallel_tool_calls: true,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    }
    if (req.tools) {
      payload.tools = req.tools
      payload.tool_choice = 'auto'
    }
    if (req.previousResponseId) {
      payload.previous_response_id = req.previousResponseId
    }
    return payload
  }

  /** Pull `response.id` from `response.completed` events so the caller
   *  can chain the next turn. Returns null until the final event arrives. */
  extractResponseId(ev: unknown): string | null {
    if (!ev || typeof ev !== 'object') return null
    const e = ev as { type?: unknown; response?: { id?: unknown } }
    if (e.type !== 'response.completed') return null
    const id = e.response?.id
    return typeof id === 'string' && id ? id : null
  }
}

// ---------- Gemini (api_key + Vertex AI) ----------

interface GeminiRequest {
  /** Pre-built body — caller (gemini.ts) does the contents/tools
   *  assembly because Gemini's wire model differs enough that a single
   *  generic strategy adds zero value. The strategy hook is reserved
   *  for Phase F (`cachedContents` API) which will let callers pre-
   *  attach a `cachedContent` reference. */
  body: Record<string, unknown>
  /** Optional `cachedContents` resource name from Phase F. Reserved
   *  shape — gemini.ts ignores it for v1. */
  cachedContent?: string
}

/**
 * Phase D stub. Gemini caching uses a separate `cachedContents` REST
 * resource (4096-32768 token minimum prefix) rather than inline
 * cache_control markers, so v1 doesn't try to layer it onto the
 * normal generateContent call. Implicit auto-cache still fires
 * server-side when the prefix repeats; usage tokens are reported via
 * `usageMetadata.cachedContentTokenCount` regardless.
 *
 * Phase F will populate `cachedContent` on the returned payload to opt
 * into the explicit cache when the workload measurement justifies it.
 */
export class GeminiCachingStrategy
  implements CachingStrategy<GeminiRequest, Record<string, unknown>>
{
  applyToRequest(req: GeminiRequest): Record<string, unknown> {
    if (req.cachedContent) {
      return { ...req.body, cachedContent: req.cachedContent }
    }
    return req.body
  }
}

// ---------- Noop (Copilot) ----------

interface CopilotRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolSpec[] | null
  temperature: number
}

interface CopilotPayload {
  model: string
  messages: ChatMessage[]
  temperature: number
  stream: true
  tools?: ToolSpec[]
  tool_choice?: string
}

/** Copilot has no cache protocol; strategy is a stable identity function. */
export class NoopCachingStrategy
  implements CachingStrategy<CopilotRequest, CopilotPayload>
{
  applyToRequest(req: CopilotRequest): CopilotPayload {
    const payload: CopilotPayload = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      stream: true,
    }
    if (req.tools && req.tools.length > 0) {
      payload.tools = req.tools
      payload.tool_choice = 'auto'
    }
    return payload
  }
}
