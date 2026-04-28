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

    if (req.system) {
      // Single ephemeral marker on system caches persona + team outline +
      // relay rules + skill index across turns.
      payload.system = [
        { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
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
          block.cache_control = { type: 'ephemeral' }
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
            cache_control: { type: 'ephemeral' },
          } as AnthropicBlock & { cache_control: { type: 'ephemeral' } },
        ]
      } else if (Array.isArray(last.content) && last.content.length > 0) {
        const tail = last.content[last.content.length - 1]!
        ;(tail as AnthropicBlock & { cache_control?: unknown }).cache_control = {
          type: 'ephemeral',
        }
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
