/**
 * PKCE helpers (RFC 7636). Ports apps/server/openhive/auth/pkce.py.
 */

import crypto from 'node:crypto'

interface PKCEChallenge {
  code_verifier: string
  code_challenge: string
  state: string
}

function urlsafeB64(raw: Buffer): string {
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce(): PKCEChallenge {
  const codeVerifier = urlsafeB64(crypto.randomBytes(32))
  const digest = crypto.createHash('sha256').update(codeVerifier).digest()
  const codeChallenge = urlsafeB64(digest)
  const state = urlsafeB64(crypto.randomBytes(16))
  return { code_verifier: codeVerifier, code_challenge: codeChallenge, state }
}
