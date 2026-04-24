/**
 * OpenAI Codex OAuth — Authorization Code + PKCE.
 * Ports apps/server/openhive/auth/codex.py.
 */

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access'
const EXTRA: Record<string, string> = {
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: 'codex_cli_rs',
}

export function buildAuthorizeUrl(
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  // OpenAI's authorize endpoint is strict about space encoding in `scope`:
  // URLSearchParams encodes ` ` as `+` (application/x-www-form-urlencoded),
  // which OpenAI rejects for query-string context. Manually assemble with
  // encodeURIComponent to get `%20` — mirrors the reference 9router impl
  // in `src/lib/oauth/services/codex.js:20-35`.
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...EXTRA,
    state,
  }
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `${AUTHORIZE_URL}?${qs}`
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `Codex token exchange failed (${resp.status}): ${await resp.text()}`,
    )
  }
  return (await resp.json()) as Record<string, unknown>
}
