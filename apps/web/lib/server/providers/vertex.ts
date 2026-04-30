/**
 * Vertex AI adapter — Google Cloud Vertex AI Generative AI endpoint.
 *
 * Endpoint shape:
 *   - region != 'global':  https://{region}-aiplatform.googleapis.com
 *   - region == 'global':  https://aiplatform.googleapis.com
 *   path: /v1/projects/{project}/locations/{region}/publishers/google
 *         /models/{model}:streamGenerateContent?alt=sse
 *
 * Auth: service-account JSON → JWT(RS256) → access_token (1h TTL),
 *       handled by `auth/vertex.ts`. Project id comes from the SA JSON.
 *
 * Default region: `global` — verified 2026-04-30 probe that the Gemini
 * 3.x preview models (`gemini-3.1-pro-preview`,
 * `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`) are NOT
 * provisioned in `us-central1` / `us-west4`. Operators with a region
 * pinned by data residency policy can override via `VERTEX_LOCATION`
 * env (or the per-credential `account_label` field, which is treated
 * as the region when set).
 *
 * Wire shape: identical to Gemini api_key. We delegate to the shared
 * builder/parser (`gemini-shared.ts`) and only own auth + URL.
 *
 * Concurrency: capped at 6 inflight calls per process (env-tunable
 * via `OPENHIVE_VERTEX_CONCURRENCY`). Vertex region quotas are tight
 * enough that an unconstrained `delegate_parallel` fan-out trips 429
 * immediately — the semaphore queues client-side instead.
 */

import { getVertexAuth } from '../auth/vertex'
import { loadToken } from '../tokens'
import { redactCredentials } from './errors'
import {
  DEFAULT_SAFETY_SETTINGS,
  sseEventsGemini,
  thinkingConfigFor,
  toGeminiContents,
  toolsToGemini,
} from './gemini-shared'
import { Semaphore } from './semaphore'
import type { ChatMessage, ToolSpec } from './types'

const VERTEX_CONCURRENCY = Math.max(
  1,
  Number(process.env.OPENHIVE_VERTEX_CONCURRENCY ?? 6) || 6,
)
const semaphore = new Semaphore(VERTEX_CONCURRENCY)

function vertexHost(region: string): string {
  return region === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${region}-aiplatform.googleapis.com`
}

function buildUrl(region: string, project: string, model: string): string {
  const host = vertexHost(region)
  return (
    `${host}/v1/projects/${encodeURIComponent(project)}` +
    `/locations/${encodeURIComponent(region)}` +
    `/publishers/google/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse`
  )
}

function resolveLocation(): string {
  const fromEnv = process.env.VERTEX_LOCATION?.trim()
  if (fromEnv) return fromEnv
  const record = loadToken('vertex-ai')
  // Operators can stash a per-credential region override in account_label
  // (e.g. for data-residency policies). Falls through to `global` when
  // unset — that's where Gemini 3 preview models live.
  const fromLabel = record?.account_label?.trim()
  if (fromLabel) return fromLabel
  return 'global'
}

export interface StreamOpts {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  sessionId?: string
  chainKey?: string
  nativeWebSearch?: boolean
  effort?: 'low' | 'medium' | 'high'
  temperature?: number
  maxOutputTokens?: number
}

export async function* streamGenerateContent(
  opts: StreamOpts,
): AsyncIterable<Record<string, unknown>> {
  const release = await semaphore.acquire()
  try {
    const auth = await getVertexAuth('vertex-ai')
    const location = resolveLocation()
    const chainKey = opts.chainKey ?? opts.sessionId
    const { systemInstruction, contents } = toGeminiContents(opts.messages, chainKey)

    const tools: unknown[] = []
    const fnDecls = toolsToGemini(opts.tools)
    if (fnDecls) tools.push(fnDecls)
    if (opts.nativeWebSearch) tools.push({ googleSearch: {} })

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        thinkingConfig: thinkingConfigFor(opts.model, opts.effort ?? 'medium'),
        ...(typeof opts.temperature === 'number' ? { temperature: opts.temperature } : {}),
        ...(typeof opts.maxOutputTokens === 'number'
          ? { maxOutputTokens: opts.maxOutputTokens }
          : {}),
      },
      safetySettings: DEFAULT_SAFETY_SETTINGS,
    }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (tools.length > 0) body.tools = tools

    const url = buildUrl(location, auth.projectId, opts.model)
    const timeoutMs = Number(process.env.OPENHIVE_VERTEX_TIMEOUT_MS ?? 600_000)
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 600_000,
      ),
    })
    if (!resp.ok || !resp.body) {
      const text = resp.body ? await resp.text() : ''
      throw new Error(redactCredentials(`Vertex AI ${resp.status}: ${text}`))
    }

    yield* sseEventsGemini(resp.body)
  } finally {
    release()
  }
}

/** Inspection helper for tests / observability — exposes inflight + queued
 *  counts without leaking the semaphore instance itself. */
export function vertexConcurrencyStats(): { inflight: number; queued: number; max: number } {
  return {
    inflight: semaphore.inflight,
    queued: semaphore.queued,
    max: semaphore.max,
  }
}
