/**
 * Provider-facing streaming dispatch.
 * Ports apps/server/openhive/engine/providers.py.
 *
 * Each per-provider client in lib/server/providers/* streams native events;
 * this module normalises them into the engine's neutral StreamDelta shape
 * (text / tool_call / usage / stop). The engine loop only sees deltas.
 */

import * as claude from '../providers/claude'
import * as codex from '../providers/codex'
import * as copilot from '../providers/copilot'
import type {
  ChatMessage,
  StreamDelta,
  ToolSpec,
} from '../providers/types'

export type { StreamDelta, ChatMessage, ToolSpec } from '../providers/types'

export async function* stream(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
): AsyncIterable<StreamDelta> {
  if (providerId === 'copilot') {
    yield* streamCopilot(model, messages, tools)
    return
  }
  if (providerId === 'claude-code') {
    yield* streamClaude(model, messages, tools)
    return
  }
  if (providerId === 'codex') {
    yield* streamCodex(model, messages, tools)
    return
  }
  throw new Error(
    `provider '${providerId}' not yet wired into the engine. Use 'copilot', 'claude-code', or 'codex'.`,
  )
}

/** Build the initial OpenAI-shaped message array for a node. */
export function buildMessages(
  system: string,
  history: ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  out.push(...history)
  return out
}

// -------- Copilot (OpenAI-compatible chat/completions) --------

async function* streamCopilot(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
): AsyncIterable<StreamDelta> {
  for await (const chunk of copilot.streamChat({ model, messages, tools })) {
    const usage = (chunk as { usage?: Record<string, unknown> }).usage
    if (usage) {
      // OpenAI-shaped usage nests cache metrics under prompt_tokens_details.
      // prompt_tokens is the TOTAL input (cached + fresh); cached_tokens is
      // the portion served from the auto-cache (1024+ token stable prefix).
      const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
      const cached = Number(details.cached_tokens ?? 0)
      yield {
        kind: 'usage',
        input_tokens: Number(usage.prompt_tokens ?? 0),
        output_tokens: Number(usage.completion_tokens ?? 0),
        cache_read_tokens: cached || undefined,
      }
    }
    const choices = (chunk as { choices?: Record<string, unknown>[] }).choices ?? []
    const choice = choices[0] ?? {}
    const delta = (choice.delta ?? {}) as Record<string, unknown>
    const text = delta.content
    if (typeof text === 'string' && text) {
      yield { kind: 'text', text }
    }
    for (const tcRaw of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      const fn = (tcRaw.function ?? {}) as Record<string, unknown>
      yield {
        kind: 'tool_call',
        index: Number(tcRaw.index ?? 0),
        id: typeof tcRaw.id === 'string' ? tcRaw.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : undefined,
        arguments_chunk: typeof fn.arguments === 'string' ? fn.arguments : '',
      }
    }
    const finish = choice.finish_reason
    if (typeof finish === 'string' && finish) {
      yield { kind: 'stop', reason: finish }
      return
    }
  }
  yield { kind: 'stop', reason: 'stop' }
}

// -------- Claude Code (Anthropic Messages API) --------

async function* streamClaude(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
): AsyncIterable<StreamDelta> {
  // Content-block index → tool_use ordinal (engine keeps dense keys).
  const toolOrdinal = new Map<number, number>()
  let nextToolIdx = 0
  let usageIn = 0
  let usageOut = 0
  let usageCacheRead = 0
  let usageCacheWrite = 0

  for await (const ev of claude.streamMessages({ model, messages, tools })) {
    const t = (ev as { type?: string }).type
    if (t === 'message_start') {
      const u = ((ev as { message?: { usage?: Record<string, unknown> } }).message?.usage ?? {}) as Record<string, unknown>
      usageIn = Number(u.input_tokens ?? 0)
      usageOut = Number(u.output_tokens ?? 0)
      usageCacheRead = Number(u.cache_read_input_tokens ?? 0)
      usageCacheWrite = Number(u.cache_creation_input_tokens ?? 0)
    } else if (t === 'content_block_start') {
      const idx = Number((ev as { index?: number }).index ?? 0)
      const block = ((ev as { content_block?: Record<string, unknown> }).content_block ?? {}) as Record<string, unknown>
      if (block.type === 'tool_use') {
        const ord = nextToolIdx++
        toolOrdinal.set(idx, ord)
        yield {
          kind: 'tool_call',
          index: ord,
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          arguments_chunk: '',
        }
      }
    } else if (t === 'content_block_delta') {
      const idx = Number((ev as { index?: number }).index ?? 0)
      const delta = ((ev as { delta?: Record<string, unknown> }).delta ?? {}) as Record<string, unknown>
      if (delta.type === 'text_delta') {
        const text = typeof delta.text === 'string' ? delta.text : ''
        if (text) yield { kind: 'text', text }
      } else if (delta.type === 'input_json_delta') {
        const chunk = typeof delta.partial_json === 'string' ? delta.partial_json : ''
        const ord = toolOrdinal.get(idx)
        if (ord !== undefined && chunk) {
          yield { kind: 'tool_call', index: ord, arguments_chunk: chunk }
        }
      }
    } else if (t === 'message_delta') {
      const delta = ((ev as { delta?: Record<string, unknown> }).delta ?? {}) as Record<string, unknown>
      const u = ((ev as { usage?: Record<string, unknown> }).usage ?? {}) as Record<string, unknown>
      if (Object.keys(u).length > 0) {
        usageOut = Math.max(usageOut, Number(u.output_tokens ?? 0))
      }
      const reason = delta.stop_reason
      if (typeof reason === 'string' && reason) {
        yield {
          kind: 'usage',
          input_tokens: usageIn,
          output_tokens: usageOut,
          cache_read_tokens: usageCacheRead,
          cache_write_tokens: usageCacheWrite,
        }
        yield {
          kind: 'stop',
          reason: reason === 'tool_use' ? 'tool_calls' : reason,
        }
        return
      }
    } else if (t === 'message_stop') {
      yield {
        kind: 'usage',
        input_tokens: usageIn,
        output_tokens: usageOut,
        cache_read_tokens: usageCacheRead,
        cache_write_tokens: usageCacheWrite,
      }
      yield { kind: 'stop', reason: 'stop' }
      return
    }
    // ignore ping, error (errors are thrown upstream)
  }
}

// -------- Codex (Responses API via ChatGPT backend) --------

async function* streamCodex(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
): AsyncIterable<StreamDelta> {
  const toolOrd = new Map<string, number>()
  let nextToolIdx = 0

  for await (const ev of codex.streamResponses({ model, messages, tools })) {
    const t = (ev as { type?: string }).type
    if (t === 'response.output_text.delta') {
      const text = (ev as { delta?: unknown }).delta
      if (typeof text === 'string' && text) yield { kind: 'text', text }
    } else if (t === 'response.output_item.added') {
      const item = ((ev as { item?: Record<string, unknown> }).item ?? {}) as Record<string, unknown>
      if (item.type === 'function_call') {
        const itemId = typeof item.id === 'string' ? item.id : ''
        if (!toolOrd.has(itemId)) {
          toolOrd.set(itemId, nextToolIdx++)
        }
        yield {
          kind: 'tool_call',
          index: toolOrd.get(itemId)!,
          id:
            typeof item.call_id === 'string'
              ? item.call_id
              : typeof item.id === 'string'
                ? item.id
                : undefined,
          name: typeof item.name === 'string' ? item.name : undefined,
          arguments_chunk: '',
        }
      }
    } else if (t === 'response.function_call_arguments.delta') {
      const itemId = typeof (ev as { item_id?: unknown }).item_id === 'string'
        ? ((ev as { item_id: string }).item_id)
        : ''
      const delta = (ev as { delta?: unknown }).delta
      const ord = toolOrd.get(itemId)
      if (ord !== undefined && typeof delta === 'string' && delta) {
        yield { kind: 'tool_call', index: ord, arguments_chunk: delta }
      }
    } else if (t === 'response.completed') {
      const response = ((ev as { response?: Record<string, unknown> }).response ?? {}) as Record<string, unknown>
      const u = (response.usage ?? {}) as Record<string, unknown>
      if (Object.keys(u).length > 0) {
        const inputDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>
        yield {
          kind: 'usage',
          input_tokens: Number(u.input_tokens ?? 0),
          output_tokens: Number(u.output_tokens ?? 0),
          cache_read_tokens: Number(inputDetails.cached_tokens ?? 0),
        }
      }
      const outs = (response.output as Record<string, unknown>[] | undefined) ?? []
      const sawTool = outs.some((i) => i.type === 'function_call')
      yield { kind: 'stop', reason: sawTool ? 'tool_calls' : 'stop' }
      return
    } else if (t === 'response.error' || t === 'error') {
      const err = (ev as { error?: unknown }).error ?? ev
      throw new Error(`Codex stream error: ${JSON.stringify(err)}`)
    }
  }
}
