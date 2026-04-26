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
  // simultaneously and the model picks per-call.
  const nativeWebSearch = opts?.nativeWebSearch ?? true
  if (providerId === 'claude-code') {
    yield* streamClaude(model, messages, tools, { ...opts, nativeWebSearch })
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
  opts?: StreamOpts & { nativeWebSearch?: boolean },
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

async function* streamCodex(
  model: string,
  messages: ChatMessage[],
  tools: ToolSpec[] | undefined,
  sessionId: string | undefined,
  nativeWebSearch: boolean,
  chainKey: string | undefined,
): AsyncIterable<StreamDelta> {
  const toolOrd = new Map<string, number>()
  let nextToolIdx = 0
  let textStreamed = false
  // Codex emits the actual search query inside `response.output_item.added`
  // for `web_search_call` items (`item.action.query`), but the per-phase
  // lifecycle events (`web_search_call.in_progress|searching|completed`)
  // only carry the bare `item_id`. Buffer the query keyed by item_id so
  // we can attach it to each native_tool delta — without this the UI
  // chip can only show a generic placeholder and dozens of identical
  // pills are useless to the user.
  const nativeQueryByItemId = new Map<string, string>()
  // url_citation annotations Codex attaches to the assistant text via
  // `response.output_text.annotation.added`. Accumulated for the whole
  // stream and flushed once at `response.completed` as a synthetic
  // `native_tool` delta with `phase: 'completed'` + `sources: [...]` —
  // the UI renders this as ONE consolidated sources card per agent turn
  // (replaces the per-search placeholder chip the user found useless).
  // Annotations from Codex aren't keyed back to the originating
  // web_search_call, so per-search attribution isn't possible; one card
  // per turn is the honest UX.
  const nativeSources: { title?: string; url: string; domain?: string }[] = []
  const seenSourceUrls = new Set<string>()
  let sawNativeSearch = false

  for await (const ev of codex.streamResponses({
    model,
    messages,
    tools,
    sessionId,
    chainKey,
    nativeWebSearch,
  })) {
    const t = (ev as { type?: string }).type
    // Hosted-tool lifecycle. Codex emits these for `web_search` and any
    // other provider-managed tool. We don't yield them as `tool_call`
    // (no function-call round-trip needed) but surface them as
    // `native_tool` deltas so the engine can log per-phase events for
    // the UI — otherwise a 30-150s search burst is invisible.
    if (
      t === 'response.web_search_call.in_progress' ||
      t === 'response.web_search_call.searching' ||
      t === 'response.web_search_call.completed'
    ) {
      const phase =
        t === 'response.web_search_call.in_progress'
          ? 'in_progress'
          : t === 'response.web_search_call.searching'
            ? 'searching'
            : 'completed'
      const itemId = typeof (ev as { item_id?: unknown }).item_id === 'string'
        ? (ev as { item_id: string }).item_id
        : undefined
      const query = itemId ? nativeQueryByItemId.get(itemId) : undefined
      sawNativeSearch = true
      yield { kind: 'native_tool', tool: 'web_search', phase, itemId, query }
      continue
    }
    // Codex web_search splits one model "search" intent into multiple
    // `web_search_call` items, each with a different action. Action
    // shapes observed (probe `apps/web/scripts/probe-native-events.ts`):
    //   - `output_item.added` → action is EMPTY (`{}`); the action is
    //     resolved server-side after the call runs.
    //   - `output_item.done`  → action is populated with one of:
    //       `{ type: 'search',       query: '...' }`
    //       `{ type: 'open_page',    url:   '...' }`
    //       `{ type: 'find_in_page', url:   '...', pattern: '...' }`
    // Codex does NOT emit `response.output_text.annotation.added`
    // (verified). The `open_page` / `find_in_page` URLs ARE the
    // citations. Capture them on `output_item.done` and also pick up
    // queries here (the `added` handler below cannot — action is empty
    // at that point). Dedup sources by URL.
    if (t === 'response.output_item.done') {
      const item = ((ev as { item?: Record<string, unknown> }).item ?? {}) as Record<string, unknown>
      if (item.type === 'web_search_call') {
        const action = (item.action ?? {}) as Record<string, unknown>
        const aType = typeof action.type === 'string' ? action.type : ''
        const url = typeof action.url === 'string' ? action.url : ''
        if (
          (aType === 'open_page' || aType === 'find_in_page') &&
          url &&
          !seenSourceUrls.has(url)
        ) {
          seenSourceUrls.add(url)
          let domain: string | undefined
          try {
            domain = new URL(url).hostname.replace(/^www\./, '')
          } catch {
            /* ignore malformed urls */
          }
          nativeSources.push({
            url,
            title:
              typeof action.title === 'string'
                ? action.title
                : typeof item.title === 'string'
                  ? (item.title as string)
                  : undefined,
            domain,
          })
        }
        if (aType === 'search') {
          const query = typeof action.query === 'string' ? action.query : ''
          const itemId = typeof item.id === 'string' ? item.id : ''
          if (itemId && query) nativeQueryByItemId.set(itemId, query)
        }
      }
    }
    if (t === 'response.output_text.delta') {
      const text = (ev as { delta?: unknown }).delta
      if (typeof text === 'string' && text) {
        textStreamed = true
        // Codex's web_search results aren't always exposed as
        // `open_page`/`find_in_page` action items — sometimes the model
        // just runs a `search` action and embeds the citation URLs
        // inline in the assistant text (verified via probe). Extract
        // them so sources cards show the actual references the model
        // used. Only scan when a web_search ran in this turn to avoid
        // pulling URLs from regular non-search outputs (code samples,
        // user-provided links echoed back, etc.). Dedup with the same
        // Set used by `output_item.done` capture.
        if (sawNativeSearch) {
          for (const m of text.matchAll(/https?:\/\/[^\s)\]<>"'`]+/g)) {
            let url = m[0].replace(/[.,;:!?]+$/, '')
            // Drop trailing parens that aren't balanced inside the URL.
            const opens = (url.match(/\(/g) ?? []).length
            const closes = (url.match(/\)/g) ?? []).length
            while (closes > opens && url.endsWith(')')) {
              url = url.slice(0, -1)
            }
            if (!seenSourceUrls.has(url)) {
              seenSourceUrls.add(url)
              let domain: string | undefined
              try {
                domain = new URL(url).hostname.replace(/^www\./, '')
              } catch {
                continue
              }
              nativeSources.push({ url, domain })
            }
          }
        }
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
      } else if (item.type === 'web_search_call') {
        // Capture the query before any phase event fires for this item.
        // Codex shape (verified via probe): `item.action.query` carries the
        // model-chosen search string. Some Codex variants instead surface
        // it under `item.query` directly — fall back to that. Without this
        // capture every native chip in the UI shows an identical generic
        // placeholder.
        const itemId = typeof item.id === 'string' ? item.id : ''
        const action = (item.action ?? {}) as Record<string, unknown>
        const query =
          (typeof action.query === 'string' && action.query) ||
          (typeof item.query === 'string' && (item.query as string)) ||
          ''
        if (itemId && query) nativeQueryByItemId.set(itemId, query)
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
      // Flush accumulated url_citations as the final native_tool delta
      // for the turn. Only emit when at least one web_search_call ran
      // this stream — empty/unrelated streams shouldn't push a chip.
      // The transcript builder uses this delta to render one sources
      // card per agent turn.
      if (sawNativeSearch) {
        yield {
          kind: 'native_tool',
          tool: 'web_search',
          phase: 'completed',
          sources: nativeSources,
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
