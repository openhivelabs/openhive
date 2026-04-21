/**
 * OAuth token store — FS-only. Tokens live Fernet-encrypted in
 *   ~/.openhive/oauth.enc.json
 *
 * We hold the full record map in one file and rewrite on save. At single-digit
 * provider counts this is fine; if it ever grows we can shard per-provider.
 */

import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths'
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

interface StoredRow {
  provider_id: string
  access_token: string           // encrypted
  refresh_token: string | null   // encrypted
  expires_at: number | null
  scope: string | null
  account_label: string | null
  account_id: string | null
  created_at: number
  updated_at: number
}

function tokensPath(): string {
  return path.join(dataDir(), 'oauth.enc.json')
}

function readAll(): Record<string, StoredRow> {
  const p = tokensPath()
  if (!fs.existsSync(p)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (raw && typeof raw === 'object') ? (raw as Record<string, StoredRow>) : {}
  } catch {
    return {}
  }
}

function writeAll(rows: Record<string, StoredRow>): void {
  const p = tokensPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}

export function saveToken(record: TokenRecord): void {
  const rows = readAll()
  const now = Math.floor(Date.now() / 1000)
  const prev = rows[record.provider_id]
  rows[record.provider_id] = {
    provider_id: record.provider_id,
    access_token: encrypt(record.access_token),
    refresh_token: record.refresh_token ? encrypt(record.refresh_token) : null,
    expires_at: record.expires_at,
    scope: record.scope,
    account_label: record.account_label,
    account_id: record.account_id,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  }
  writeAll(rows)
}

export function loadToken(providerId: string): TokenRecord | null {
  const rows = readAll()
  const row = rows[providerId]
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
  const rows = readAll()
  if (!(providerId in rows)) return false
  delete rows[providerId]
  writeAll(rows)
  return true
}

export function listConnected(): string[] {
  return Object.keys(readAll())
}

export function getAccountLabel(providerId: string): string | null {
  const row = readAll()[providerId]
  return row?.account_label ?? null
}
