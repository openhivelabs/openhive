/**
 * Fernet-compatible token encryption. Uses the same key file
 * (~/.openhive/encryption.key) as the Python side (cryptography.fernet) so
 * tokens persisted by either runtime decrypt in the other.
 *
 * The `fernet` npm package implements the same AES-128-CBC + HMAC-SHA256
 * scheme as `cryptography.Fernet`. Key bytes are interchangeable.
 */

import fs from 'node:fs'
// The fernet package has no types; we import as any and narrow locally.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fernet = require('fernet') as {
  Secret: new (key: string) => unknown
  Token: new (opts: { secret: unknown; token?: string; ttl?: number }) => {
    encode(message: string): string
    decode(): string
  }
}
import { encryptionKeyPath } from './paths'
import { getSettings } from './config'

let cachedSecret: unknown | null = null

function loadOrCreateKey(): string {
  const override = getSettings().encryptionKey
  if (override) return override
  const keyPath = encryptionKeyPath()
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8').trim()
  }
  // Generate a new Fernet key — 32 random bytes, urlsafe-base64 encoded. This
  // matches `Fernet.generate_key()` output exactly.
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const key = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
  return key
}

function getSecret(): unknown {
  if (cachedSecret === null) {
    cachedSecret = new fernet.Secret(loadOrCreateKey())
  }
  return cachedSecret
}

export function encrypt(plain: string): string {
  const token = new fernet.Token({ secret: getSecret() })
  return token.encode(plain)
}

export function decrypt(cipher: string): string {
  const token = new fernet.Token({
    secret: getSecret(),
    token: cipher,
    // 0 = no TTL check (matches Python side which doesn't set a TTL either).
    ttl: 0,
  })
  return token.decode()
}
