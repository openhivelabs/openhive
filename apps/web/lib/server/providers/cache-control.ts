/**
 * Unified provider cache invalidation. Called from the disconnect
 * endpoint so re-connecting with a different credential doesn't get
 * shadowed by a stale in-memory entry (auth tokens, response chains,
 * thoughtSignature anchors).
 *
 * Centralized so the route handler doesn't need to know each adapter's
 * private cache shape.
 */

import { clearClaudeAuthCache } from './claude'
import { clearCodexChain, clearCodexSessionCache } from './codex'
import { clearCopilotSessionCache } from './copilot-session'
import { clearGeminiChain } from './gemini-shared'
import { clearOpenAIChain } from './openai'
import { clearVertexAuth } from '../auth/vertex'

/** Drop every in-memory cache associated with `providerId`. Safe to
 *  call for any provider id — unrelated caches are no-op. */
export function clearProviderCache(providerId: string): void {
  switch (providerId) {
    case 'claude-code':
    case 'anthropic':
      clearClaudeAuthCache(providerId)
      return
    case 'codex':
      clearCodexSessionCache(providerId)
      // Per-session chain state is keyed by sessionId — we don't have
      // that here, so on disconnect we accept that any in-flight chain
      // for this codex token will 401 on its next call and self-heal
      // when the engine retries. Keeps the hook simple.
      return
    case 'copilot':
      clearCopilotSessionCache(providerId)
      return
    case 'openai':
      // OpenAI chain is keyed by sessionId; same trade-off as codex.
      // The chain entry self-heals on the first 400 from the server
      // when a stale `previous_response_id` is sent.
      return
    case 'gemini':
      // Gemini chain is per-sessionId for thoughtSignature anchors.
      // Mismatched signatures get rejected → engine retries fresh.
      return
    case 'vertex-ai':
      clearVertexAuth(providerId)
      return
  }
}

/** Best-effort: walk every per-session chain state for a given session.
 *  Called from session teardown (engine session-registry) so stale
 *  reasoning anchors don't accumulate. */
export function clearSessionScopedCaches(sessionId: string): void {
  clearCodexChain(sessionId)
  clearOpenAIChain(sessionId)
  clearGeminiChain(sessionId)
}
