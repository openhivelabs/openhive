/**
 * Model catalogs per provider.
 * Ports apps/server/openhive/providers/models.py.
 *
 * Claude Code + Codex: hardcoded (subscription APIs don't expose /models).
 * Copilot: dynamic via its /models endpoint; falls back to a small default
 * catalog when the user hasn't connected yet.
 */

import { EDITOR_HEADERS, getCopilotSession } from './copilot-session'

interface ModelCatalogEntry {
  id: string
  label: string
  default?: boolean
}

export const CLAUDE_CODE_MODELS: ModelCatalogEntry[] = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', default: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

export const ANTHROPIC_MODELS: ModelCatalogEntry[] = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', default: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
]

export const CODEX_MODELS: ModelCatalogEntry[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', default: true },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini' },
]

export const OPENAI_MODELS: ModelCatalogEntry[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5', default: true },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini' },
]

// Gemini 3.x models all carry the `-preview` suffix on the wire (verified
// against generativelanguage.googleapis.com/v1beta/models on 2026-04-30).
// Catalog ids match the wire ids exactly; the label hides the suffix.
export const GEMINI_MODELS: ModelCatalogEntry[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', default: true },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3.0 Flash' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
]

// Vertex AI carries the same wire ids. Default region is `global` — Gemini
// 3 preview models are not provisioned in us-central1 / us-west4 yet.
export const VERTEX_MODELS: ModelCatalogEntry[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', default: true },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3.0 Flash' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
]

const COPILOT_FALLBACK: ModelCatalogEntry[] = [
  { id: 'gpt-5-mini', label: 'GPT-5 mini', default: true },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
]

export async function listModelsFor(
  providerId: string,
): Promise<ModelCatalogEntry[]> {
  if (providerId === 'claude-code') return CLAUDE_CODE_MODELS
  if (providerId === 'anthropic') return ANTHROPIC_MODELS
  if (providerId === 'codex') return CODEX_MODELS
  if (providerId === 'openai') return OPENAI_MODELS
  if (providerId === 'gemini') return GEMINI_MODELS
  if (providerId === 'vertex-ai') return VERTEX_MODELS
  if (providerId === 'copilot') {
    let session
    try {
      session = await getCopilotSession()
    } catch {
      return COPILOT_FALLBACK
    }
    const api = session.endpoints.api ?? 'https://api.githubcopilot.com'
    const resp = await fetch(`${api}/models`, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...EDITOR_HEADERS,
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      throw new Error(
        `copilot /models failed (${resp.status}): ${await resp.text()}`,
      )
    }
    const data = (await resp.json()) as { data?: Record<string, unknown>[] }
    const seen = new Set<string>()
    const out: ModelCatalogEntry[] = []
    for (const m of data.data ?? []) {
      const id = typeof m.id === 'string' ? m.id : null
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        label: typeof m.name === 'string' ? m.name : id,
        default: id === 'gpt-5-mini',
      })
    }
    // Sort so the default floats to the top.
    out.sort(
      (a, b) =>
        Number(!a.default) - Number(!b.default) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    return out
  }
  return []
}
