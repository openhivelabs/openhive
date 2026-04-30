/**
 * Shared SSE → StreamDelta normalizer for the OpenAI Responses API.
 *
 * Both Codex (`chatgpt.com/backend-api/codex/responses` via OAuth) and the
 * direct OpenAI api_key adapter (`api.openai.com/v1/responses`) stream the
 * same event shapes — `response.output_item.{added,done}`, `response
 * .output_text.delta`, `response.function_call_arguments.delta`, `response
 * .web_search_call.{in_progress,searching,completed}`, `response.completed`.
 *
 * This module owns the *consumption* side. The *source* side stays in each
 * adapter — Codex layers `attach_item_ids` reasoning-anchor capture on top
 * via its own `streamResponsesOnce` helper, and the OpenAI api_key adapter
 * (Phase C) will use `previous_response_id + store: true` instead. Both
 * funnel raw events through this normalizer.
 *
 * Behaviour is intentionally byte-equivalent to the previous inline
 * `streamCodex` in `engine/providers.ts` — Phase B is a pure refactor with
 * no semantic changes.
 */

import type { ChatMessage, StreamDelta, ToolSpec } from './types'

// -------- Wire shape helpers (Responses API) --------
//
// These translate the engine's OpenAI-Chat canonical shape into the
// Responses API's `instructions` + `input[]` + `tools[]` shapes, parse
// SSE events, and re-export the `ResponseInputItem` shape used by both
// adapters (Codex re-attaches buffered reasoning items via this type).

export interface ResponseInputItem {
  type: string
  role?: string
  content?: { type: string; text: string }[]
  call_id?: string
  output?: string
  name?: string
  arguments?: string
  /** Server-assigned ids — required by Codex's `attach_item_ids` reasoning
   *  anchor strategy when re-submitting on subsequent rounds. The OpenAI
   *  api_key adapter uses `previous_response_id + store: true` instead and
   *  doesn't populate these. */
  id?: string
  encrypted_content?: string
  summary?: unknown
}

export function toResponsesInput(
  messages: ChatMessage[],
): { system: string | null; items: ResponseInputItem[] } {
  let system: string | null = null
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? `${system}\n\n` : '') + (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: m.tool_call_id ?? '',
        output: typeof m.content === 'string' ? m.content : '',
      })
      continue
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        })
      }
      for (const tc of m.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        })
      }
      continue
    }
    items.push({
      type: 'message',
      role: m.role ?? 'user',
      content: [
        {
          type: 'input_text',
          text: typeof m.content === 'string' ? m.content : '',
        },
      ],
    })
  }
  return { system, items }
}

export function toolsToResponses(tools: ToolSpec[] | undefined): unknown[] | null {
  if (!tools || tools.length === 0) return null
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description ?? '',
    parameters: t.function.parameters ?? { type: 'object', properties: {} },
    strict: false,
  }))
}

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      try {
        yield JSON.parse(raw) as Record<string, unknown>
      } catch {
        /* skip malformed chunks */
      }
    }
  }
}

export async function* normalizeResponsesStream(
  events: AsyncIterable<Record<string, unknown>>,
): AsyncIterable<StreamDelta> {
  // function_call output-item.id → engine ordinal. Tool calls fan out
  // server-side with non-dense ids; we keep dense engine indices so the
  // tool dispatcher can address them by index.
  const toolOrd = new Map<string, number>()
  let nextToolIdx = 0
  let textStreamed = false
  // The actual search query lives on `response.output_item.added` for
  // `web_search_call` items (`item.action.query`), but the per-phase
  // lifecycle events (`web_search_call.in_progress|searching|completed`)
  // only carry the bare `item_id`. Buffer the query keyed by item_id so
  // each native_tool delta can carry it — without this every UI chip
  // shows an identical generic placeholder.
  const nativeQueryByItemId = new Map<string, string>()
  // url_citation accumulator. Flushed once at `response.completed` as a
  // synthetic `native_tool` delta with `phase: 'completed'` + `sources` —
  // the UI renders one consolidated sources card per agent turn.
  // Annotations aren't keyed back to the originating web_search_call,
  // so per-search attribution isn't possible; one card per turn is the
  // honest UX.
  const nativeSources: { title?: string; url: string; domain?: string }[] = []
  const seenSourceUrls = new Set<string>()
  let sawNativeSearch = false

  for await (const ev of events) {
    const t = (ev as { type?: string }).type
    // Hosted-tool lifecycle. Surface as `native_tool` deltas so the
    // engine can log per-phase events for the UI — otherwise a 30-150s
    // search burst is invisible.
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
    //   - `output_item.added` → action is EMPTY (`{}`); resolved server-
    //     side after the call runs.
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
        // The model sometimes runs a `search` action and embeds the
        // citation URLs inline in the assistant text (verified via
        // probe). Extract them so sources cards show the actual
        // references the model used. Only scan when a web_search ran
        // in this turn to avoid pulling URLs from regular non-search
        // outputs (code samples, user-provided links echoed back).
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
        // Wire shape (verified): `item.action.query` carries the model-
        // chosen search string. Some variants surface it under
        // `item.query` directly — fall back to that. Without this every
        // native chip in the UI shows an identical generic placeholder.
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
      // `sawTool` reflects whether THIS stream carried any function_call
      // item (tracked via toolOrd from `output_item.added`). Scanning
      // `response.output` on the completion envelope used to be the
      // source of truth, but in streaming mode that field is empty
      // (items are delivered out-of-band) — that's why tool-calling
      // responses were silently classified as `stop_reason=stop` and
      // the engine's round loop never continued.
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
export function extractCompletedMessageText(
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
