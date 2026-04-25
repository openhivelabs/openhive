/**
 * Shared provider types — the engine's canonical (OpenAI-shaped) message and
 * tool format. Per-provider modules translate to/from their native shape.
 */

export interface FunctionCall {
  name: string
  arguments: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: FunctionCall
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content?: string | null
  /** Populated for role=assistant when the model calls tools. */
  tool_calls?: ToolCall[]
  /** Populated for role=tool — the call being answered. */
  tool_call_id?: string
  /** Optional name on role=tool for OpenAI's shape. */
  name?: string
  /** Internal — never serialized to provider. Epoch ms timestamp used by
   *  microcompact to tell whether the last assistant turn is still "hot"
   *  (within the provider's prefix-cache TTL). Stripped by `buildMessages`
   *  before the payload leaves the engine. */
  _ts?: number
}

export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/**
 * Cross-provider caching interface.
 *
 * Each provider translates the engine's canonical request into its own
 * wire shape; the caching strategy is the hook where provider-native
 * cache markers / chaining ids are injected. Implementations:
 *
 *  - AnthropicCachingStrategy — attaches `cache_control: ephemeral`
 *    markers (3 breakpoints: system, last tool, last user message).
 *  - CodexCachingStrategy — attaches `previous_response_id` for
 *    Responses-API prefix reuse; captures ids from the stream.
 *  - NoopCachingStrategy — passthrough (Copilot has no cache protocol).
 *
 * The strategy is intentionally typed loosely — the shape of the
 * returned payload is provider-specific and validated by the caller.
 */
export interface CachingRequest<M = ChatMessage, T = ToolSpec> {
  system: string | null
  messages: M[]
  tools: T[] | null
  previousResponseId?: string | null
}

export interface CachingStrategy<Req = CachingRequest, Payload = unknown> {
  /** Inject provider-native cache markers / id into the outgoing payload. */
  applyToRequest(req: Req): Payload
  /** Pull the id needed to chain on the next turn (Codex only). */
  extractResponseId?(resp: unknown): string | null
}

/** Neutral streaming delta — per-provider streams are normalised to this. */
export type StreamDelta =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_call'
      index: number
      id?: string
      name?: string
      arguments_chunk?: string
    }
  | {
      kind: 'usage'
      input_tokens?: number
      output_tokens?: number
      cache_read_tokens?: number
      cache_write_tokens?: number
    }
  | {
      /** Provider-side hosted tool progress (e.g. Codex `web_search`,
       *  Anthropic `web_search_20250305`). These are NOT engine function
       *  calls — the provider runs them itself and folds results into
       *  the assistant turn — but surfacing the lifecycle to the UI is
       *  important: without it, a 30-150s search burst looks identical
       *  to a frozen session. The engine emits a `native_tool` event
       *  per delta so the timeline shows "🔍 web_search • searching" /
       *  "✓ web_search • completed" instead of nothing. */
      kind: 'native_tool'
      tool: string
      phase: 'in_progress' | 'searching' | 'completed' | 'failed'
      itemId?: string
      /** Provider-supplied query string when available (Codex puts it in
       *  `output_item.added.item.action.query`; Anthropic in
       *  `server_tool_use.input.query`). Without it the UI can only show
       *  a generic chip — adding the real query lets users distinguish
       *  e.g. "GPT-5.5 release April 2026" from "Anthropic Opus 4.7
       *  release date" in a long timeline. */
      query?: string
      /** Citations the provider attached to the assistant text — Codex
       *  emits them as `response.output_text.annotation.added` events
       *  with `url_citation` shape. Aggregated per stream and surfaced
       *  on the synthesized `phase: 'completed'` delta so the UI can
       *  render one sources card per agent turn (same renderer as the
       *  function-shaped `web-search` skill output, but without a
       *  separate query chip). */
      sources?: Array<{ title?: string; url: string; domain?: string }>
    }
  | { kind: 'stop'; reason?: string }
