/**
 * Copilot API session cache.
 * Ports the _session_cache + _get_session logic from
 * apps/server/openhive/proxy/copilot.py (the token-fetch parts — the chat
 * streaming path is handled by the engine in Phase 4).
 *
 * Two-stage auth:
 *   1. Long-lived GitHub OAuth token → GET api.github.com/copilot_internal/v2/token
 *      → short-lived Copilot session token (~30 min)
 *   2. Short-lived token is used against api.githubcopilot.com endpoints with
 *      the editor identity headers.
 *
 * Sessions are cached on globalThis so HMR doesn't force re-fetching.
 */

import { loadToken } from '../tokens'

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

export const EDITOR_HEADERS: Record<string, string> = {
  'Editor-Version': 'vscode/1.85.0',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'User-Agent': 'GitHubCopilotChat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
}

interface CachedSession {
  token: string
  expiresAt: number
  endpoints: Record<string, string>
}

const globalForCache = globalThis as unknown as {
  __openhive_copilot_session?: Map<string, CachedSession>
}

function cache(): Map<string, CachedSession> {
  if (!globalForCache.__openhive_copilot_session) {
    globalForCache.__openhive_copilot_session = new Map()
  }
  return globalForCache.__openhive_copilot_session
}

/** Drop the cached Copilot session so a fresh OAuth credential isn't
 *  shadowed by a stale ephemeral token. */
export function clearCopilotSessionCache(providerId = 'copilot'): void {
  cache().delete(providerId)
}

async function refreshSession(providerId: string): Promise<CachedSession> {
  const record = loadToken(providerId)
  if (!record) {
    throw new Error('Copilot is not connected. Connect it in Settings first.')
  }
  const resp = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${record.access_token}`,
      Accept: 'application/json',
      ...EDITOR_HEADERS,
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `copilot_internal/v2/token failed (${resp.status}): ${await resp.text()}`,
    )
  }
  const data = (await resp.json()) as {
    token: string
    expires_at?: number
    endpoints?: Record<string, string>
  }
  const session: CachedSession = {
    token: data.token,
    expiresAt: Number(data.expires_at ?? Date.now() / 1000 + 1500),
    endpoints: data.endpoints ?? {},
  }
  cache().set(providerId, session)
  return session
}

export async function getCopilotSession(
  providerId = 'copilot',
): Promise<CachedSession> {
  const hit = cache().get(providerId)
  if (hit && hit.expiresAt - 60 > Date.now() / 1000) return hit
  return refreshSession(providerId)
}
