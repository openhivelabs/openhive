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
