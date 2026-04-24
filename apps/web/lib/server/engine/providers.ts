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

/** Extra knobs the engine threads through to provider adapters. Each
 *  provider picks up only the fields it cares about. */
export interface StreamOpts {
  /** Tell caching strategy not to reorder tools — fork children require
   *  byte-identical prefix for Anthropic prompt-cache hit. */
  useExactTools?: boolean
  /** Replace `system` with this exact string (skip `splitSystem` synthesis) —
   *  fork children inherit the parent's verbatim system prompt. */
  overrideSystem?: string
  /** Per-turn sampling temperature. Lower = more deterministic / terse.
   *  Engine passes 0.3 for depth-0 Lead turns; 0.7 default otherwise.
   *  Currently wired for copilot only. */
  temperature?: number
  /** Session this turn belongs to. Codex uses it to key the
   *  `previous_response_id` chaining store so concurrent sessions don't
   *  clobber each other's state. */
  sessionId?: string
}

export async function* stream(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  opts?: StreamOpts,
): AsyncIterable<StreamDelta> {
  if (providerId === 'copilot') {
    yield* streamCopilot(model, messages, tools, opts?.temperature)
    return
  }
  if (providerId === 'claude-code') {
    yield* streamClaude(model, messages, tools, opts)
    return
  }
  if (providerId === 'codex') {
    yield* streamCodex(model, messages, tools, opts?.sessionId)
    return
  }
  throw new Error(
    `provider '${providerId}' not yet wired into the engine. Use 'copilot', 'claude-code', or 'codex'.`,
  )
}

/** Build the initial OpenAI-shaped message array for a node.
 *
 *  Strips the internal `_ts` field so provider clients never see it —
 *  microcompact uses it on the engine-side `history`, but providers only
 *  want the OpenAI-shaped `{role, content, tool_calls, tool_call_id, name}`.
 */
export function buildMessages(
  system: string,
  history: ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of history) {
    const clean: ChatMessage = { role: m.role }
    if (m.content !== undefined) clean.content = m.content
    if (m.tool_calls !== undefined) clean.tool_calls = m.tool_calls
    if (m.tool_call_id !== undefined) clean.tool_call_id = m.tool_call_id
    if (m.name !== undefined) clean.name = m.name
    out.push(clean)
  }
  return out
}

// -------- Copilot (OpenAI-compatible chat/completions) --------

async function* streamCopilot(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  temperature?: number,
): AsyncIterable<StreamDelta> {
  for await (const chunk of copilot.streamChat({ model, messages, tools, temperature })) {
    const usage = (chunk as { usage?: Record<string, unknown> }).usage
    if (usage) {
      // OpenAI-shaped usage nests cache metrics under prompt_tokens_details.
      // `prompt_tokens` is TOTAL input (cached + fresh); `cached_tokens` is the
      // portion served from the auto-cache (1024+ token stable prefix).
      //
      // We normalize to Anthropic's disjoint convention here — `input_tokens`
      // downstream always means "fresh only", never cache-inclusive. Cost
      // estimation depends on this: if we leave cache folded into input_tokens
      // it gets billed at the fresh rate instead of the 50%-off cache-read
      // rate, and the cost display inflates 2× (or 8× for the full legacy
      // `startsWith` bug that first prompted this refactor).
      const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
      const cached = Number(details.cached_tokens ?? 0)
      const prompt = Number(usage.prompt_tokens ?? 0)
      yield {
        kind: 'usage',
        input_tokens: Math.max(0, prompt - cached),
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
  opts?: StreamOpts,
): AsyncIterable<StreamDelta> {
  // Content-block index → tool_use ordinal (engine keeps dense keys).
  const toolOrdinal = new Map<number, number>()
  let nextToolIdx = 0
  let usageIn = 0
  let usageOut = 0
  let usageCacheRead = 0
  let usageCacheWrite = 0

  for await (const ev of claude.streamMessages({
    model,
    messages,
    tools,
    useExactTools: opts?.useExactTools,
    overrideSystem: opts?.overrideSystem,
  })) {
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
  sessionId: string | undefined,
): AsyncIterable<StreamDelta> {
  const toolOrd = new Map<string, number>()
  let nextToolIdx = 0
  let textStreamed = false

  for await (const ev of codex.streamResponses({ model, messages, tools, sessionId })) {
    const t = (ev as { type?: string }).type
    if (t === 'response.output_text.delta') {
      const text = (ev as { delta?: unknown }).delta
      if (typeof text === 'string' && text) {
        textStreamed = true
        yield { kind: 'text', text }
      }
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
      // `sawTool` must reflect whether THIS stream carried any function_call
      // item — tracked via the toolOrd map we populated from `output_item.added`.
      // Previously we scanned `response.output` on the completion envelope, but
      // that field is empty in streaming mode (items are delivered out-of-band),
      // so tool-calling responses were silently classified as `stop_reason=stop`
      // and the engine's round loop never continued. This is the root cause
      // of the "session silently finalises with empty output" bug.
      const sawTool = toolOrd.size > 0
      const outs = (response.output as Record<string, unknown>[] | undefined) ?? []
      // Fallback: some Responses-API shapes deliver the final message
      // only inside the `response.completed` payload (no streaming text
      // deltas) — walk the output array and recover the text so the
      // engine doesn't emit an empty `node_finished`. Only run when
      // nothing streamed AND no tool calls, to avoid double-emitting
      // when streaming worked normally.
      if (!textStreamed && !sawTool) {
        const recovered = extractCompletedMessageText(outs)
        if (recovered) {
          yield { kind: 'text', text: recovered }
        }
      }
      yield { kind: 'stop', reason: sawTool ? 'tool_calls' : 'stop' }
      return
    } else if (t === 'response.error' || t === 'error') {
      const err = (ev as { error?: unknown }).error ?? ev
      throw new Error(`Codex stream error: ${JSON.stringify(err)}`)
    }
  }
}

/** Walk the `response.output` array from a Responses-API `response.completed`
 *  event and pull out any `output_text` the model emitted as message items.
 *  Shape reference: message items look like
 *    { type: 'message', role: 'assistant',
 *      content: [{ type: 'output_text', text: '...' }, ...] }
 *  — possibly multiple text chunks, possibly interleaved with reasoning
 *  items at sibling level (reasoning items are ignored here; they don't
 *  belong in the user-facing transcript). */
function extractCompletedMessageText(
  outs: Record<string, unknown>[],
): string {
  const parts: string[] = []
  for (const item of outs) {
    if (item.type !== 'message') continue
    const content = item.content as Record<string, unknown>[] | undefined
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type === 'output_text' && typeof c.text === 'string' && c.text) {
        parts.push(c.text)
      }
    }
  }
  return parts.join('')
}
