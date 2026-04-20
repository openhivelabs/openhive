/**
 * OAuth token store — encrypt on write, decrypt on read.
 * Ports apps/server/openhive/persistence/tokens.py.
 *
 * Shared `oauth_tokens` table + Fernet key with the legacy Python runtime,
 * so tokens saved by either runtime are readable by the other.
 */

import { getDb } from './db'
import { decrypt, encrypt } from './crypto'

export interface TokenRecord {
  provider_id: string
  access_token: string
  refresh_token: string | null
  expires_at: number | null
  scope: string | null
  account_label: string | null
  account_id: string | null
}

interface TokenRow {
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

export function saveToken(record: TokenRecord): void {
  const now = Math.floor(Date.now() / 1000)
  const accessEnc = encrypt(record.access_token)
  const refreshEnc = record.refresh_token ? encrypt(record.refresh_token) : null
  getDb()
    .prepare(
      `INSERT INTO oauth_tokens
        (provider_id, access_token, refresh_token, expires_at, scope, account_label,
         account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         access_token=excluded.access_token,
         refresh_token=excluded.refresh_token,
         expires_at=excluded.expires_at,
         scope=excluded.scope,
         account_label=excluded.account_label,
         account_id=excluded.account_id,
         updated_at=excluded.updated_at`,
    )
    .run(
      record.provider_id,
      accessEnc,
      refreshEnc,
      record.expires_at,
      record.scope,
      record.account_label,
      record.account_id,
      now,
      now,
    )
}

export function loadToken(providerId: string): TokenRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM oauth_tokens WHERE provider_id = ?')
    .get(providerId) as TokenRow | undefined
  if (!row) return null
  return {
    provider_id: row.provider_id,
    access_token: decrypt(row.access_token),
    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    expires_at: row.expires_at,
    scope: row.scope,
    account_label: row.account_label,
    account_id: row.account_id,
  }
}

export function deleteToken(providerId: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM oauth_tokens WHERE provider_id = ?')
    .run(providerId)
  return info.changes > 0
}

/** Provider IDs that have a stored token row (regardless of decryptability). */
export function listConnected(): string[] {
  const rows = getDb()
    .prepare('SELECT provider_id FROM oauth_tokens')
    .all() as { provider_id: string }[]
  return rows.map((r) => r.provider_id)
}

export function getAccountLabel(providerId: string): string | null {
  const row = getDb()
    .prepare('SELECT account_label FROM oauth_tokens WHERE provider_id = ?')
    .get(providerId) as { account_label: string | null } | undefined
  return row?.account_label ?? null
}
