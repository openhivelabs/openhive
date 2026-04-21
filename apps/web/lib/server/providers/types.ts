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
  | { kind: 'stop'; reason?: string }
