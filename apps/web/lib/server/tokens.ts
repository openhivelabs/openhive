/**
 * OAuth token storage. Ports apps/server/openhive/persistence/tokens.py.
 * Minimal surface for now — Phase 3 adds the full flow layer.
 *
 * Shared `oauth_tokens` table with Python runtime. Values encrypted with the
 * same Fernet key at ~/.openhive/encryption.key, so either runtime can read.
 */

import { getDb } from './db'
import { decrypt } from './crypto'

export interface TokenRow {
  provider_id: string
  access_token: string
  refresh_token: string | null
  expires_at: number | null
  scope: string | null
  account_label: string | null
  account_id: string | null
  created_at: number
  updated_at: number
}

/** Provider IDs with an active (Fernet-decryptable) access token. */
export function listConnected(): string[] {
  const rows = getDb()
    .prepare('SELECT provider_id, access_token FROM oauth_tokens')
    .all() as { provider_id: string; access_token: string }[]
  const out: string[] = []
  for (const row of rows) {
    try {
      // Verify the token still decrypts (i.e. the key hasn't rotated out).
      // We don't care about the value here — just whether it's usable.
      decrypt(row.access_token)
      out.push(row.provider_id)
    } catch {
      /* skip unreadable rows */
    }
  }
  return out
}

export function getToken(providerId: string): TokenRow | null {
  const row = getDb()
    .prepare('SELECT * FROM oauth_tokens WHERE provider_id = ?')
    .get(providerId) as TokenRow | undefined
  return row ?? null
}
