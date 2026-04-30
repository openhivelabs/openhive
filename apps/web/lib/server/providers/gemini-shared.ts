/**
 * Shared Google Gemini wire helpers — used by both `providers/gemini.ts`
 * (api_key against `generativelanguage.googleapis.com`) and
 * `providers/vertex.ts` (service-account against `*-aiplatform.google
 * apis.com`). The two endpoints differ only in URL + auth; the request /
 * response shapes are identical.
 *
 * Gemini's wire model is unlike Anthropic's `messages` or OpenAI's
 * Responses API:
 *   - `systemInstruction` is a separate top-level field (not a turn).
 *   - Conversation lives under `contents[]` with role `'user' | 'model'`.
 *   - Each turn's content is split into `parts[]`, where each part is one
 *     of: text / thought / thoughtSignature / functionCall / functionResponse.
 *   - Tools mix `functionDeclarations` with hosted tools (`googleSearch`).
 *   - Streaming SSE events are full `GenerateContentResponse` snapshots
 *     with delta `parts` — the model accumulates parts across events.
 *
 * Thought Signatures (Gemini 3.x):
 *   The model emits opaque base64 anchors on assistant `parts[i]
 *   .thoughtSignature` to preserve reasoning state across turns. To
 *   keep the chain coherent we capture the full part array of each
 *   assistant turn into a per-`chainKey` Map and re-inject those parts
 *   verbatim on the next request. ChatMessage doesn't carry the
 *   signature field so the chain state is the only place it lives.
 *
 *   Limitation: history compaction (microcompact / summarise) renumbers
 *   assistant turns, after which captured signatures attach to the
 *   wrong turn or are lost. The model recovers by re-reasoning — quality
 *   degrades, no crash.
 */

import type { ChatMessage, StreamDelta, ToolSpec } from './types'

// -------- Wire types --------

export interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args: Record<string, unknown>; id?: string }
  functionResponse?: { name: string; response: unknown; id?: string }
  inlineData?: { mimeType: string; data: string }
}

export interface GeminiContent {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  cachedContentTokenCount?: number
  totalTokenCount?: number
}

interface GroundingChunk {
  web?: { uri?: string; title?: string }
  retrievedContext?: { uri?: string; title?: string }
}

interface GroundingMetadata {
  webSearchQueries?: string[]
  groundingChunks?: GroundingChunk[]
  groundingSupports?: unknown[]
  searchEntryPoint?: { renderedContent?: string }
}

// -------- Per-chainKey state for Thought Signatures --------

interface GeminiChainState {
  /** Captured assistant turn parts, indexed by assistant message ordinal
   *  in the engine's history. On the next request we re-inject these
   *  verbatim so `thoughtSignature` round-trips. */
  assistantTurns: Map<number, GeminiPart[]>
  lastTouched: number
}

const globalForChain = globalThis as unknown as {
  __openhive_gemini_chain?: Map<string, GeminiChainState>
}

function chainStore(): Map<string, GeminiChainState> {
  if (!globalForChain.__openhive_gemini_chain) {
    globalForChain.__openhive_gemini_chain = new Map()
  }
  return globalForChain.__openhive_gemini_chain
}

export function getGeminiChain(key: string | undefined): GeminiChainState | null {
  if (!key) return null
  return chainStore().get(key) ?? null
}

export function getOrCreateGeminiChain(key: string): GeminiChainState {
  const m = chainStore()
  let s = m.get(key)
  if (!s) {
    s = { assistantTurns: new Map(), lastTouched: Date.now() }
    m.set(key, s)
  }
  return s
}

export function resetGeminiChain(chainKey: string): void {
  chainStore().delete(chainKey)
}

export function clearGeminiChain(sessionId: string): void {
  const m = chainStore()
  const prefix = `${sessionId}:`
  for (const k of m.keys()) {
    if (k === sessionId || k.startsWith(prefix)) m.delete(k)
  }
}

// -------- Wire builders --------

/** Translate the engine's OpenAI-Chat shape to Gemini's `contents` shape.
 *  The system message is hoisted into `systemInstruction`. Assistant
 *  messages from a known chain re-use captured parts (preserving
 *  `thoughtSignature` for reasoning continuity). */
export function toGeminiContents(
  messages: ChatMessage[],
  chainKey: string | undefined,
): {
  systemInstruction: { parts: { text: string }[] } | undefined
  contents: GeminiContent[]
} {
  const state = chainKey ? getGeminiChain(chainKey) : null
  let systemText = ''
  const contents: GeminiContent[] = []
  let assistantOrdinal = 0

  for (const m of messages) {
    if (m.role === 'system') {
      systemText = (systemText ? `${systemText}\n\n` : '') + (m.content ?? '')
      continue
    }
    if (m.role === 'tool') {
      // Map OpenAI-Chat tool result back onto a `functionResponse` part.
      // Gemini wire doesn't carry the function name on tool_result — the
      // engine never persists it on the message either, so we reconstruct
      // it by walking back to the matching assistant tool_call.
      const callId = m.tool_call_id ?? ''
      const name = lookupFunctionName(messages, callId)
      const responseText = typeof m.content === 'string' ? m.content : ''
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name,
              id: callId || undefined,
              response: { content: responseText },
            },
          },
        ],
      })
      continue
    }
    if (m.role === 'assistant') {
      // Prefer captured parts (preserves thoughtSignature). Fall back
      // to reconstructing from text + tool_calls when no chain entry.
      const captured = state?.assistantTurns.get(assistantOrdinal)
      if (captured && captured.length > 0) {
        contents.push({ role: 'model', parts: captured })
      } else {
        const parts: GeminiPart[] = []
        if (typeof m.content === 'string' && m.content) {
          parts.push({ text: m.content })
        }
        for (const tc of m.tool_calls ?? []) {
          let args: Record<string, unknown> = {}
          try {
            args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
          } catch {
            args = { _raw: tc.function.arguments }
          }
          parts.push({ functionCall: { name: tc.function.name, args, id: tc.id } })
        }
        if (parts.length === 0) parts.push({ text: '' })
        contents.push({ role: 'model', parts })
      }
      assistantOrdinal += 1
      continue
    }
    // user or other → user role with a single text part.
    contents.push({
      role: 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : '' }],
    })
  }

  return {
    systemInstruction: systemText
      ? { parts: [{ text: systemText }] }
      : undefined,
    contents,
  }
}

/** Walk earlier assistant tool_calls to find the function name that
 *  matches the engine's tool_call_id. Gemini's `functionResponse` part
 *  requires the name even though the engine's tool message doesn't
 *  carry it. */
function lookupFunctionName(messages: ChatMessage[], callId: string): string {
  if (!callId) return ''
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const tc of m.tool_calls ?? []) {
      if (tc.id === callId) return tc.function.name
    }
  }
  return ''
}

/** Translate engine `ToolSpec[]` to Gemini's `functionDeclarations`
 *  array. Gemini's parameter schema is OpenAPI 3.0 subset — `oneOf` /
 *  `anyOf` / `allOf` are partially supported, `$ref` is not. We pass
 *  the parameters object through; Phase D's `tool-translation.test.ts`
 *  measures real-world MCP catalogue compatibility. */
export function toolsToGemini(
  tools: ToolSpec[] | undefined,
): { functionDeclarations: unknown[] } | null {
  if (!tools || tools.length === 0) return null
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    })),
  }
}

/** Choose the thinking config payload for a given Gemini model. Gemini
 *  3.x uses `thinkingLevel` (low/medium/high), Gemini 2.5 used
 *  `thinkingBudget` (integer). Both fields can NOT coexist in one
 *  request — server returns 400 if both present. */
export function thinkingConfigFor(model: string, effort: 'low' | 'medium' | 'high' = 'medium') {
  if (model.startsWith('gemini-3')) {
    return { thinkingLevel: effort.toUpperCase(), includeThoughts: true }
  }
  // Gemini 2.5 fallback (catalogue removes 2.5 but we leave the branch
  // for users on legacy custom models).
  const budget = effort === 'low' ? 0 : effort === 'high' ? 8192 : 1024
  return { thinkingBudget: budget, includeThoughts: true }
}

/** Default safety settings — without these Gemini blocks code-assistant
 *  workloads with `finishReason: SAFETY` on borderline content. */
export const DEFAULT_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
]

// -------- SSE parsing --------

/** Parse a Gemini SSE body. Each event is one full
 *  `GenerateContentResponse` snapshot, with `parts` carrying the delta
 *  since the last event. Reuses the OpenAI SSE parser shape (data:
 *  prefixed JSON lines). */
export async function* sseEventsGemini(
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

// -------- SSE → StreamDelta normalizer --------

interface NormalizeOpts {
  /** When true, the caller attached the `googleSearch` builtin tool;
   *  groundingMetadata in any chunk triggers a `native_tool` completion
   *  delta. Without this we still process events but don't synthesize
   *  search lifecycle. */
  nativeWebSearch: boolean
  /** Engine assistant ordinal of the turn we're streaming. Used to
   *  index thoughtSignature capture into chain state on completion. */
  assistantOrdinalOnCompletion?: number
  /** Chain key for thought signature capture. When provided, captured
   *  parts go into `getOrCreateGeminiChain(chainKey).assistantTurns`. */
  chainKey?: string
}

/** Map Gemini's SSE events to engine `StreamDelta`s. */
export async function* normalizeGeminiStream(
  events: AsyncIterable<Record<string, unknown>>,
  opts: NormalizeOpts,
): AsyncIterable<StreamDelta> {
  // Captured assistant parts for THIS turn — committed to chain state
  // on finishReason or stream end.
  const capturedParts: GeminiPart[] = []
  // Track tool_call ordinals across multiple functionCall parts in one turn.
  let nextToolIdx = 0
  const toolOrdinalById = new Map<string, number>()
  let sawGrounding = false
  const collectedSources: { title?: string; url: string; domain?: string }[] = []
  const seenSourceUrls = new Set<string>()
  let usage: GeminiUsageMetadata | undefined
  let finishReason: string | undefined
  let errorPayload: unknown
  let textStreamed = false

  for await (const ev of events) {
    // Server-side error envelope (4xx / 5xx that came back as JSON in
    // the SSE stream rather than an HTTP non-2xx).
    if ((ev as { error?: unknown }).error !== undefined) {
      errorPayload = (ev as { error: unknown }).error
      break
    }

    const candidates = (ev as { candidates?: unknown[] }).candidates
    if (Array.isArray(candidates) && candidates.length > 0) {
      const cand = candidates[0] as {
        content?: { parts?: GeminiPart[]; role?: string }
        finishReason?: string
        groundingMetadata?: GroundingMetadata
      }

      const parts = cand.content?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          // Capture every part for chain state — preserves
          // thoughtSignature even on parts we don't yield (thought=true).
          capturedParts.push(part)

          if (part.thought === true) {
            // Reasoning text is for the model, not the user. Don't
            // surface in the transcript.
            continue
          }
          if (typeof part.text === 'string' && part.text) {
            textStreamed = true
            yield { kind: 'text', text: part.text }
            continue
          }
          if (part.functionCall) {
            const call = part.functionCall
            const callId = call.id ?? `gemfn_${nextToolIdx}_${Date.now()}`
            let ord = toolOrdinalById.get(callId)
            if (ord === undefined) {
              ord = nextToolIdx++
              toolOrdinalById.set(callId, ord)
            }
            const args = (() => {
              try {
                return JSON.stringify(call.args ?? {})
              } catch {
                return '{}'
              }
            })()
            yield {
              kind: 'tool_call',
              index: ord,
              id: callId,
              name: call.name,
              arguments_chunk: args,
            }
          }
        }
      }

      const gm = cand.groundingMetadata
      if (gm && opts.nativeWebSearch) {
        sawGrounding = true
        const chunks = gm.groundingChunks ?? []
        for (const c of chunks) {
          const url = c.web?.uri ?? c.retrievedContext?.uri ?? ''
          if (!url || seenSourceUrls.has(url)) continue
          seenSourceUrls.add(url)
          let domain: string | undefined
          try {
            domain = new URL(url).hostname.replace(/^www\./, '')
          } catch {
            /* ignore malformed urls */
          }
          collectedSources.push({
            url,
            title: c.web?.title ?? c.retrievedContext?.title,
            domain,
          })
        }
      }

      if (cand.finishReason) finishReason = cand.finishReason
    }

    const um = (ev as { usageMetadata?: GeminiUsageMetadata }).usageMetadata
    if (um) usage = um
  }

  if (errorPayload !== undefined) {
    throw new Error(`Gemini stream error: ${JSON.stringify(errorPayload)}`)
  }

  // Commit captured parts to chain state for next-turn thoughtSignature
  // round-trip. Empty parts arrays are skipped (no signal to preserve).
  if (
    opts.chainKey &&
    capturedParts.length > 0 &&
    opts.assistantOrdinalOnCompletion !== undefined
  ) {
    const state = getOrCreateGeminiChain(opts.chainKey)
    state.assistantTurns.set(opts.assistantOrdinalOnCompletion, capturedParts)
    state.lastTouched = Date.now()
  }

  if (usage) {
    yield {
      kind: 'usage',
      input_tokens: Math.max(
        0,
        (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
      ),
      output_tokens:
        (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cache_read_tokens: usage.cachedContentTokenCount || undefined,
    }
  }

  // Search did happen → flush sources card. Phase synthesis: we don't
  // emit `searching` because Gemini gives us no signal during the
  // search itself. The UI sees text streaming, then a final
  // sources card when grounding is observed.
  if (sawGrounding) {
    yield {
      kind: 'native_tool',
      tool: 'web_search',
      phase: 'completed',
      sources: collectedSources,
    }
  }

  // Map Gemini finishReason → engine stop reason. Tool calls don't
  // produce STOP — Gemini uses STOP for normal completion AND when
  // returning function calls (tool_calls flagged via toolOrdinalById).
  const sawTool = toolOrdinalById.size > 0
  if (
    finishReason &&
    finishReason !== 'STOP' &&
    finishReason !== 'MAX_TOKENS' &&
    finishReason !== 'TOOL_CALL'
  ) {
    // SAFETY / RECITATION / OTHER — surface as a stop with the literal
    // reason so the UI can show why.
    yield { kind: 'stop', reason: finishReason.toLowerCase() }
    return
  }

  // Recovery: if no streaming text and no tool call, pull text out of
  // captured parts (Gemini sometimes batches a small response into a
  // single non-streaming-shaped event).
  if (!textStreamed && !sawTool && capturedParts.length > 0) {
    const recovered = capturedParts
      .filter((p) => !p.thought && typeof p.text === 'string' && p.text)
      .map((p) => p.text as string)
      .join('')
    if (recovered) yield { kind: 'text', text: recovered }
  }

  yield { kind: 'stop', reason: sawTool ? 'tool_calls' : 'stop' }
}
