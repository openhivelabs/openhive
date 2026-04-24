/**
 * Credential vault — FS-only, fernet-encrypted.
 *
 * Stores user-supplied API keys (OpenWeather, Notion integration tokens, …)
 * and, optionally, an index that wraps the OAuth token store so panel
 * bindings can reference them under a single `auth_ref` namespace.
 *
 * Layout:
 *   ~/.openhive/credentials.enc.json
 *   {
 *     version: 1,
 *     entries: {
 *       "<ref_id>": {
 *         ref_id, kind: 'api_key' | 'oauth',
 *         provider?: string,             // oauth only — same id as in oauth.enc.json
 *         value_enc?: string,            // fernet — api_key only
 *         scopes?: string[],
 *         label?: string,
 *         added_at: unix-ms
 *       }
 *     }
 *   }
 *
 * The raw key value is NEVER returned from any REST endpoint. Only
 * `getCredentialValue()` (server-internal) returns the plaintext, and only
 * the source resolver calls it at fetch time.
 */

import fs from 'node:fs'
import path from 'node:path'
import { decrypt, encrypt } from './crypto'
import { dataDir } from './paths'
import { loadToken } from './tokens'

export type CredentialKind = 'api_key' | 'oauth'

export interface CredentialMeta {
  ref_id: string
  kind: CredentialKind
  provider?: string
  scopes?: string[]
  label?: string
  added_at: number
}

interface StoredEntry extends CredentialMeta {
  /** Fernet-encrypted value. Present only for `api_key` kind. OAuth kind
   *  defers to `tokens.ts` (double-storage avoided). */
  value_enc?: string
}

interface StoredFile {
  version: 1
  entries: Record<string, StoredEntry>
}

const VAULT_VERSION = 1

function vaultPath(): string {
  return path.join(dataDir(), 'credentials.enc.json')
}

function readVault(): StoredFile {
  const p = vaultPath()
  if (!fs.existsSync(p)) return { version: VAULT_VERSION, entries: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<StoredFile>
    if (!raw || raw.version !== VAULT_VERSION || !raw.entries) {
      return { version: VAULT_VERSION, entries: {} }
    }
    return raw as StoredFile
  } catch {
    return { version: VAULT_VERSION, entries: {} }
  }
}

function writeVault(file: StoredFile): void {
  const p = vaultPath()
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

function toMeta(entry: StoredEntry): CredentialMeta {
  const { value_enc: _drop, ...meta } = entry
  return meta
}

export function listCredentials(): CredentialMeta[] {
  const vault = readVault()
  return Object.values(vault.entries)
    .map(toMeta)
    .sort((a, b) => (a.ref_id < b.ref_id ? -1 : a.ref_id > b.ref_id ? 1 : 0))
}

export function getCredentialMeta(refId: string): CredentialMeta | null {
  const vault = readVault()
  const entry = vault.entries[refId]
  return entry ? toMeta(entry) : null
}

/**
 * Resolve a credential ref to its plaintext value. For `api_key`, returns the
 * decrypted value. For `oauth`, returns the current access token (refreshing
 * upstream is the caller's responsibility — `tokens.getToken` just reads).
 *
 * Returns null if the entry is missing.
 *
 * NEVER expose this to an API response — server-internal only.
 */
export function getCredentialValue(refId: string): string | null {
  const vault = readVault()
  const entry = vault.entries[refId]
  if (!entry) return null
  if (entry.kind === 'api_key') {
    if (!entry.value_enc) return null
    try {
      return decrypt(entry.value_enc)
    } catch {
      return null
    }
  }
  if (entry.kind === 'oauth' && entry.provider) {
    const token = loadToken(entry.provider)
    return token?.access_token ?? null
  }
  return null
}

export interface AddApiKeyInput {
  ref_id: string
  value: string
  label?: string
  scopes?: string[]
}

export function addApiKey(input: AddApiKeyInput): CredentialMeta {
  if (!input.ref_id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.ref_id)) {
    throw new Error('ref_id must be lowercase alphanum + _/- (<=64 chars)')
  }
  if (!input.value) throw new Error('value required')
  const vault = readVault()
  const entry: StoredEntry = {
    ref_id: input.ref_id,
    kind: 'api_key',
    value_enc: encrypt(input.value),
    label: input.label,
    scopes: input.scopes,
    added_at: Date.now(),
  }
  vault.entries[input.ref_id] = entry
  writeVault(vault)
  return toMeta(entry)
}

export function deleteCredential(refId: string): boolean {
  const vault = readVault()
  if (!vault.entries[refId]) return false
  delete vault.entries[refId]
  writeVault(vault)
  return true
}

/**
 * Register an OAuth provider under a vault ref so panel bindings can reference
 * it via `auth_ref`. No value is stored here — the actual tokens stay in
 * `oauth.enc.json`. This is just an index entry.
 */
export function registerOauthRef(refId: string, provider: string, label?: string): CredentialMeta {
  const vault = readVault()
  const entry: StoredEntry = {
    ref_id: refId,
    kind: 'oauth',
    provider,
    label,
    added_at: Date.now(),
  }
  vault.entries[refId] = entry
  writeVault(vault)
  return toMeta(entry)
}
