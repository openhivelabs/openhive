/**
 * GitHub Copilot OAuth — Device Code flow.
 * Ports apps/server/openhive/auth/copilot.py.
 *
 *   1. POST /login/device/code  → device_code + user_code + verification_uri
 *   2. Show user_code; user visits the URI and types it
 *   3. Poll /oauth/access_token at `interval` seconds until user completes
 *   4. GET /user to resolve the account label
 */

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const SCOPES = 'read:user'
const USER_AGENT = 'GitHubCopilotChat/0.26.7'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  interval?: number
  expires_in?: number
  [k: string]: unknown
}

export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES })
  const resp = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    throw new Error(
      `GitHub device code failed (${resp.status}): ${await resp.text()}`,
    )
  }
  return (await resp.json()) as DeviceCodeResponse
}

/** Returns the token dict once the user completes auth, else null for pending. */
export async function pollToken(
  deviceCode: string,
): Promise<Record<string, unknown> | null> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const data = (await resp.json()) as Record<string, unknown>
  if (typeof data.access_token === 'string') return data
  const error = data.error
  if (error === 'authorization_pending' || error === 'slow_down') return null
  throw new Error(`GitHub device poll failed: ${JSON.stringify(data)}`)
}

export async function fetchAccountLabel(
  accessToken: string,
): Promise<string | null> {
  const resp = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (resp.status !== 200) return null
  const data = (await resp.json()) as Record<string, unknown>
  return (
    (typeof data.login === 'string' ? data.login : null) ??
    (typeof data.email === 'string' ? data.email : null)
  )
}
