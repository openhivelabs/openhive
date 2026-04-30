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
import * as gemini from '../providers/gemini'
import { normalizeGeminiStream } from '../providers/gemini-shared'
import * as openai from '../providers/openai'
import { normalizeResponsesStream } from '../providers/openai-response-shared'
import * as vertex from '../providers/vertex'
import type {
  ChatMessage,
  StreamDelta,
  ToolSpec,
} from '../providers/types'

/** Extra knobs the engine threads through to provider adapters. Each
 *  provider picks up only the fields it cares about. */
interface StreamOpts {
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
  /** Per-agent chain key. Multiple concurrent streams within a single
   *  engine session (parallel sibling delegates, or any two codex agents
   *  running at once) must NOT share reasoning anchors — see codex.ts
   *  StreamOpts.chainKey for the full reasoning. The engine mints one
   *  chainKey per `runNode` invocation. */
  chainKey?: string
  /** Enable the provider's hosted server-side web_search builtin
   *  (Codex `web_search`, Anthropic `web_search_20250305`). The flag is
   *  per-call so callers that explicitly want to disable it (regression
   *  tests, deterministic eval runs) can override the engine default.
   *  Copilot lacks hosted-tool support and ignores this flag. */
  nativeWebSearch?: boolean
  /** Reasoning effort hint. Mapped onto provider-native fields:
   *   - codex / openai → `reasoning.effort`
   *   - gemini / vertex → `thinkingLevel` / `thinkingBudget`
   *  Used here for the `effort='minimal'` web_search gate (gpt-5
   *  family rejects native search at minimal). */
  effort?: 'minimal' | 'low' | 'medium' | 'high'
}

/** Whether the (provider, model, effort) tuple supports the provider-
 *  hosted web_search builtin. Returns false for known disallowed
 *  combinations so the dispatcher doesn't trip a 4xx; otherwise true.
 *
 *  Verified rules (2026-04-30):
 *    - OpenAI / Codex `gpt-5` with `reasoning.effort: 'minimal'` does
 *      NOT support web_search (platform.openai.com docs).
 *    - All other GPT-5.x / Claude 4.x / Gemini 3.x combinations support
 *      it. */
export function supportsNativeSearch(
  providerId: string,
  model: string,
  effort?: 'minimal' | 'low' | 'medium' | 'high',
): boolean {
  if (
    (providerId === 'openai' || providerId === 'codex') &&
    model === 'gpt-5' &&
    effort === 'minimal'
  ) {
    return false
  }
  return true
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
  // Codex + Claude support a hosted server-side web_search tool. Default
  // to ON unless the caller explicitly opted out — failures fall back to
  // our function-shaped `web-search` skill since both stay registered
  // simultaneously and the model picks per-call. Then gate on the
  // (provider, model, effort) compatibility table to avoid a guaranteed
  // 4xx from upstream (e.g. gpt-5 + minimal reasoning rejects search).
  const nativeWebSearch =
    (opts?.nativeWebSearch ?? true) &&
    supportsNativeSearch(providerId, model, opts?.effort)
  if (providerId === 'claude-code' || providerId === 'anthropic') {
    yield* streamClaude(model, messages, tools, { ...opts, nativeWebSearch, providerId })
    return
  }
  if (providerId === 'codex') {
    yield* streamCodex(
      model,
      messages,
      tools,
      opts?.sessionId,
      nativeWebSearch,
      opts?.chainKey,
    )
    return
  }
  if (providerId === 'openai') {
    yield* streamOpenAI(
      model,
      messages,
      tools,
      opts?.sessionId,
      nativeWebSearch,
      opts?.chainKey,
    )
    return
  }
  if (providerId === 'gemini') {
    yield* streamGemini(
      model,
      messages,
      tools,
      opts?.sessionId,
      nativeWebSearch,
      opts?.chainKey,
    )
    return
  }
  if (providerId === 'vertex-ai') {
    yield* streamVertex(
      model,
      messages,
      tools,
      opts?.sessionId,
      nativeWebSearch,
      opts?.chainKey,
    )
    return
  }
  throw new Error(
    `provider '${providerId}' not yet wired into the engine. Use 'copilot', 'claude-code', 'anthropic', 'codex', 'openai', 'gemini', or 'vertex-ai'.`,
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
  opts?: StreamOpts & { nativeWebSearch?: boolean; providerId?: string },
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
    nativeWebSearch: opts?.nativeWebSearch,
    providerId: opts?.providerId ?? 'claude-code',
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
      } else if (block.type === 'server_tool_use') {
        // Anthropic hosted-tool start (web_search). Surface lifecycle
        // for the UI; no function round-trip needed.
        yield {
          kind: 'native_tool',
          tool: typeof block.name === 'string' ? block.name : 'web_search',
          phase: 'in_progress',
          itemId: typeof block.id === 'string' ? block.id : undefined,
        }
      } else if (block.type === 'web_search_tool_result') {
        // Hosted-tool completion — Anthropic delivers result content
        // inline; we just mark the phase so the UI can show "completed".
        yield {
          kind: 'native_tool',
          tool: 'web_search',
          phase: 'completed',
          itemId:
            typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string'
              ? (block as { tool_use_id: string }).tool_use_id
              : undefined,
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
//
// Thin wrapper. The SSE → StreamDelta normalization lives in
// `providers/openai-response-shared.ts` so the upcoming OpenAI api_key
// adapter (Phase C) can reuse the same logic against `api.openai.com/v1
// /responses`. Codex-specific concerns (`attach_item_ids` reasoning anchor
// capture, transient socket-drop retry-with-native-off) stay in
// `providers/codex.ts:streamResponsesOnce`, layered between the fetch
// and the normalizer.

async function* streamCodex(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  sessionId: string | undefined,
  nativeWebSearch: boolean,
  chainKey: string | undefined,
): AsyncIterable<StreamDelta> {
  yield* normalizeResponsesStream(
    codex.streamResponses({
      model,
      messages,
      tools,
      sessionId,
      chainKey,
      nativeWebSearch,
    }),
  )
}

// -------- OpenAI api_key (Responses API direct) --------
//
// Same wire shape as Codex (both target the OpenAI Responses API), so the
// SSE → StreamDelta normalization is shared. The adapter handles the
// auth + chain-state differences (`previous_response_id + store: true`
// instead of Codex's `attach_item_ids`).

async function* streamOpenAI(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  sessionId: string | undefined,
  nativeWebSearch: boolean,
  chainKey: string | undefined,
): AsyncIterable<StreamDelta> {
  yield* normalizeResponsesStream(
    openai.streamResponses({
      model,
      messages,
      tools,
      sessionId,
      chainKey,
      nativeWebSearch,
    }),
  )
}

// -------- Gemini api_key (Google AI Studio) --------
//
// Wire shape is unique to Gemini (`contents/parts` rather than
// `messages`), so unlike Codex/OpenAI which share the Responses
// normalizer, Gemini uses its own `normalizeGeminiStream`. The shared
// module also handles `thoughtSignature` capture/echo for Gemini 3.x
// reasoning continuity (per-chainKey state map).

async function* streamGemini(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  sessionId: string | undefined,
  nativeWebSearch: boolean,
  chainKey: string | undefined,
): AsyncIterable<StreamDelta> {
  // Count assistant turns currently in history — the next assistant
  // turn we're about to produce gets indexed at this ordinal in chain
  // state for thoughtSignature round-trip.
  const assistantOrdinal = messages.reduce(
    (n, m) => n + (m.role === 'assistant' ? 1 : 0),
    0,
  )
  yield* normalizeGeminiStream(
    gemini.streamGenerateContent({
      model,
      messages,
      tools,
      sessionId,
      chainKey,
      nativeWebSearch,
    }),
    {
      nativeWebSearch,
      assistantOrdinalOnCompletion: assistantOrdinal,
      chainKey: chainKey ?? sessionId,
    },
  )
}

// -------- Vertex AI (Google Cloud) --------
//
// Same wire shape as Gemini api_key. Differences live in the adapter:
//  - service-account JSON → JWT(RS256) → access_token (1h, auto-refresh)
//  - region-scoped URL (default `global`; us-central1/us-west4 don't
//    yet carry the Gemini 3 preview models — verified 2026-04-30)
//  - inflight semaphore (default 6, env-tunable) to absorb the tight
//    per-region quota without trashing 429-trip the engine.

async function* streamVertex(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  sessionId: string | undefined,
  nativeWebSearch: boolean,
  chainKey: string | undefined,
): AsyncIterable<StreamDelta> {
  const assistantOrdinal = messages.reduce(
    (n, m) => n + (m.role === 'assistant' ? 1 : 0),
    0,
  )
  yield* normalizeGeminiStream(
    vertex.streamGenerateContent({
      model,
      messages,
      tools,
      sessionId,
      chainKey,
      nativeWebSearch,
    }),
    {
      nativeWebSearch,
      assistantOrdinalOnCompletion: assistantOrdinal,
      chainKey: chainKey ?? sessionId,
    },
  )
}
