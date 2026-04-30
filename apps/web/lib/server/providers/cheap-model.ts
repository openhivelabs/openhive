/**
 * Pick a small, fast, cheap model for ancillary tasks (auto-title generation,
 * delegation result summarization, history compaction).
 *
 * The session's primary agent uses an expensive reasoning model; running
 * those one-shot helpers on the same model wastes money. This helper walks a
 * fixed provider preference order, returns the cheapest model on the first
 * connected provider, and lets callers `null`-skip when nothing is reachable.
 *
 * Connection state comes from `tokens.listConnected()` so the caller doesn't
 * need to thread that into helper functions.
 */

import { listConnected } from '../tokens'

export interface CheapModelChoice {
  providerId: string
  model: string
}

/** OAuth-first preference order. Subscription-backed providers are cheaper
 *  to the user (folded into a flat fee) so we exhaust them before paid keys. */
const PROVIDER_ORDER = [
  'codex',
  'claude-code',
  'copilot',
  'anthropic',
  'openai',
  'gemini',
  'vertex-ai',
] as const

/** Per-provider cheapest model id. These IDs must exist in `models.ts`. */
const CHEAP_MODEL: Record<string, string> = {
  'claude-code': 'claude-haiku-4-5',
  anthropic: 'claude-haiku-4-5',
  codex: 'gpt-5-mini',
  openai: 'gpt-5-mini',
  gemini: 'gemini-3-flash-preview',
  'vertex-ai': 'gemini-3-flash-preview',
  copilot: 'gpt-4o-mini',
}

export function pickCheapModel(connected?: string[]): CheapModelChoice | null {
  const reachable = new Set(connected ?? listConnected())
  for (const p of PROVIDER_ORDER) {
    if (reachable.has(p)) return { providerId: p, model: CHEAP_MODEL[p] ?? '' }
  }
  return null
}

/** Re-export so callers can also pull the raw connected list when they need
 *  it for richer routing (e.g. surfacing a multi-provider warning). */
export { listConnected }
