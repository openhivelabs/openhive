/**
 * Claude Code OAuth — Authorization Code + PKCE.
 * Ports apps/server/openhive/auth/claude.py.
 */

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'
const SCOPES = ['org:create_api_key', 'user:profile', 'user:inference']

export function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    code: 'true', // Claude-specific quirk preserved from upstream
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  state: string,
): Promise<Record<string, unknown>> {
  // Claude's UI sometimes returns "code#state" in a single param — split it.
  let authCode = code
  let fragmentState = ''
  const hashIdx = code.indexOf('#')
  if (hashIdx !== -1) {
    authCode = code.slice(0, hashIdx)
    fragmentState = code.slice(hashIdx + 1)
  }
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      code: authCode,
      state: fragmentState || state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `Claude token exchange failed (${resp.status}): ${await resp.text()}`,
    )
  }
  return (await resp.json()) as Record<string, unknown>
}
