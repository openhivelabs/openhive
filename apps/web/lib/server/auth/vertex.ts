/**
 * Vertex AI service-account auth — zero-install JWT(RS256) + token
 * exchange against `oauth2.googleapis.com/token`.
 *
 * The service-account JSON is stored in `tokens.access_token` (per
 * `dev/active/api-key-providers/context.md` §1.9). This module:
 *   1. Parses the SA JSON at first use.
 *   2. Builds a JWT signed with `node:crypto.createSign('RSA-SHA256')`
 *      — no external library needed.
 *   3. Exchanges the JWT for a Google OAuth access token (1h TTL).
 *   4. Caches the access token globally (per provider id) and refreshes
 *      automatically when within 60s of expiry.
 *
 * Probe verified the JWT flow works (`Phase 0 — probe-vertex`,
 * 2026-04-30). Probe-finding `gemini-3*-preview` models are only
 * provisioned in the `global` region; the adapter defaults there.
 */

import { createSign } from 'node:crypto'
import { redactCredentials } from '../providers/errors'
import { loadToken } from '../tokens'

export interface ServiceAccount {
  type: string
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  token_uri?: string
}

export interface VertexAuth {
  /** Bearer access token (1h TTL). */
  accessToken: string
  /** Unix seconds. */
  expiresAt: number
  /** From the SA JSON — needed to build the request URL. */
  projectId: string
}

interface CachedAuth {
  auth: VertexAuth
  /** Memoised SA so we don't re-parse the JSON every call. */
  sa: ServiceAccount
}

const globalForCache = globalThis as unknown as {
  __openhive_vertex_auth?: Map<string, CachedAuth>
}

function cache(): Map<string, CachedAuth> {
  if (!globalForCache.__openhive_vertex_auth) {
    globalForCache.__openhive_vertex_auth = new Map()
  }
  return globalForCache.__openhive_vertex_auth
}

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return b
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function buildJwt(sa: ServiceAccount, scope: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }
  const claims = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const sig = createSign('RSA-SHA256').update(signing).end().sign(sa.private_key)
  return `${signing}.${base64url(sig)}`
}

async function exchange(jwt: string, tokenUri: string): Promise<{ access_token: string; expires_in: number }> {
  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const txt = await resp.text()
    throw new Error(
      redactCredentials(`Vertex token exchange failed (${resp.status}): ${txt.slice(0, 200)}`),
    )
  }
  return (await resp.json()) as { access_token: string; expires_in: number }
}

function parseServiceAccount(json: string): ServiceAccount {
  let sa: unknown
  try {
    sa = JSON.parse(json)
  } catch {
    throw new Error('Vertex service-account JSON is malformed.')
  }
  if (!sa || typeof sa !== 'object') {
    throw new Error('Vertex service-account JSON is empty.')
  }
  const obj = sa as Record<string, unknown>
  if (
    obj.type !== 'service_account' ||
    typeof obj.project_id !== 'string' ||
    typeof obj.private_key !== 'string' ||
    typeof obj.client_email !== 'string' ||
    typeof obj.private_key_id !== 'string'
  ) {
    throw new Error('Vertex service-account JSON is missing required fields.')
  }
  return obj as unknown as ServiceAccount
}

/** Get a valid Vertex AI access token. Refreshes on demand if expired
 *  or within 60s of expiry. Reads the SA JSON from `tokens.enc.json`
 *  on first use, then caches both the parsed SA and the token. */
export async function getVertexAuth(providerId = 'vertex-ai'): Promise<VertexAuth> {
  const now = Math.floor(Date.now() / 1000)
  const hit = cache().get(providerId)
  if (hit && hit.auth.expiresAt - 60 > now) return hit.auth

  const record = loadToken(providerId)
  if (!record) {
    throw new Error('Vertex AI is not connected. Add a service-account JSON in Settings first.')
  }

  // Reuse the parsed SA if cached; otherwise parse fresh.
  const sa = hit?.sa ?? parseServiceAccount(record.access_token)
  const jwt = buildJwt(sa, 'https://www.googleapis.com/auth/cloud-platform')
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token'
  const token = await exchange(jwt, tokenUri)

  const auth: VertexAuth = {
    accessToken: token.access_token,
    expiresAt: now + Math.max(60, token.expires_in - 60),
    projectId: sa.project_id,
  }
  cache().set(providerId, { auth, sa })
  return auth
}

/** Drop cached auth + SA. Called from `clearVertexCache` when the user
 *  disconnects the provider so a stale access_token doesn't outlive
 *  the credential it came from. */
export function clearVertexAuth(providerId = 'vertex-ai'): void {
  cache().delete(providerId)
}
