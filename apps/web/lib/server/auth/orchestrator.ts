/**
 * High-level start/finish orchestration for OAuth flows.
 * Equivalent to the imperative bodies inside apps/server/openhive/api/providers.py.
 * Kept separate from the route handlers so callback handling + polling can be
 * reused (and unit-tested) without dragging the HTTP layer in.
 */

import * as claude from './claude'
import * as codex from './codex'
import { ensureCodexCallbackListener } from './codexListener'
import * as copilot from './copilot'
import {
  createFlow,
  getFlow,
  updateFlow,
  type FlowState,
} from './flows'
import { generatePkce } from './pkce'
import { getProvider } from './providers'
import { saveToken } from '../tokens'

function now(): number {
  return Math.floor(Date.now() / 1000)
}

export interface StartAuthCode {
  kind: 'auth_code'
  flow_id: string
  auth_url: string
}

export interface StartDeviceCode {
  kind: 'device_code'
  flow_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string | null
  interval: number
  expires_at: number
}

export type StartResponse = StartAuthCode | StartDeviceCode

/** Callback URI per provider. Must match a URI that the provider's
 *  OAuth server whitelists for the shared CLI client_id:
 *   - Anthropic (`9d1c250a-...`) — accepts any `http://localhost:<port>/callback`.
 *     We reuse the main Hono server's port (via the supplied `origin`).
 *   - OpenAI Codex (`app_EMoamEEZ73f0CkXaXp7hrann`) — registered for the
 *     single URI `http://localhost:1455/auth/callback`. Any other port
 *     is rejected at the authorize step as a generic `unknown_error`
 *     before the user ever sees a login page. We bind a dedicated :1455
 *     listener (see codexListener.ts) and return that fixed URI.
 *
 *  See reference 9router `src/lib/oauth/services/{claude,codex}.js` for
 *  the same pattern — specifically codex.js line ~80 pins `fixedPort = 1455`. */
function callbackUriFor(providerId: string, origin: string): string {
  if (providerId === 'codex') return 'http://localhost:1455/auth/callback'
  // claude-code + any future auth_code provider default to `/callback`
  // on the main server.
  return `${origin}/callback`
}

/** Pack the server-side `flow_id` into the OAuth `state` param so the
 *  callback handler can look up the flow without relying on provider-
 *  specific query passthrough. We used to append `&flow_id=...` to the
 *  authorize URL, but Anthropic/OpenAI reject unknown query params with a
 *  generic "Invalid request format" long before the user can log in.
 *  Format: `<pkceState>.<flowId>` (flowId is already an unguessable
 *  base64url string — embedding it keeps the whole `state` opaque). */
function packState(pkceState: string, flowId: string): string {
  return `${pkceState}.${flowId}`
}

export async function startConnect(
  providerId: string,
  origin: string,
): Promise<StartResponse> {
  const provider = getProvider(providerId)
  if (!provider) throw new Error(`unknown provider: ${providerId}`)

  if (provider.kind === 'auth_code') {
    const callbackUri = callbackUriFor(providerId, origin)
    if (providerId === 'codex') {
      // Must bind :1455 BEFORE the user opens the auth URL — otherwise
      // the post-login redirect reaches nothing and the browser just
      // shows a connection-refused error.
      await ensureCodexCallbackListener()
    }
    const challenge = generatePkce()
    const state = createFlow(providerId, 'auth_code', {
      code_verifier: challenge.code_verifier,
      expected_state: challenge.state,
      redirect_uri: callbackUri,
    })
    const wireState = packState(challenge.state, state.flow_id)
    let authUrl: string
    if (providerId === 'claude-code') {
      authUrl = claude.buildAuthorizeUrl(
        callbackUri,
        wireState,
        challenge.code_challenge,
      )
    } else if (providerId === 'codex') {
      authUrl = codex.buildAuthorizeUrl(
        callbackUri,
        wireState,
        challenge.code_challenge,
      )
    } else {
      throw new Error(`no auth_code impl for ${providerId}`)
    }
    return {
      kind: 'auth_code',
      flow_id: state.flow_id,
      auth_url: authUrl,
    }
  }

  if (provider.kind === 'device_code') {
    if (providerId !== 'copilot') {
      throw new Error(`no device_code impl for ${providerId}`)
    }
    const data = await copilot.requestDeviceCode()
    const interval = Number(data.interval ?? 5)
    const expiresAt = now() + Number(data.expires_in ?? 900)
    const state = createFlow(providerId, 'device_code', {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete ?? null,
      device_interval: interval,
      device_expires_at: expiresAt,
    })
    // Fire-and-forget background poller.
    void pollDeviceCode(state.flow_id)
    return {
      kind: 'device_code',
      flow_id: state.flow_id,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      verification_uri_complete: data.verification_uri_complete ?? null,
      interval,
      expires_at: expiresAt,
    }
  }

  throw new Error('unknown flow kind')
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return {}
    const payload = parts[1]!
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const decoded = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return {}
  }
}

export interface CallbackResult {
  ok: boolean
  message: string
}

export async function handleCallback(params: {
  code: string | null
  state: string | null
  /** Optional legacy fallback. Modern flows recover flowId by unpacking
   *  the `state` param (`<pkceState>.<flowId>`) — providers strip any
   *  unknown query param we try to smuggle through, so `state` is the
   *  only field we can trust to round-trip. */
  flowId?: string | null
  error: string | null
  errorDescription: string | null
}): Promise<CallbackResult> {
  if (params.error) {
    return { ok: false, message: params.errorDescription ?? params.error }
  }
  if (!params.code || !params.state) {
    return { ok: false, message: 'missing code/state' }
  }
  // Claude's UI sometimes tacks "#..." onto state — strip before parsing
  // the flow-id suffix.
  const stateHead = params.state.split('#')[0] ?? ''
  const dotIdx = stateHead.lastIndexOf('.')
  const pkceState = dotIdx > 0 ? stateHead.slice(0, dotIdx) : stateHead
  const flowIdFromState = dotIdx > 0 ? stateHead.slice(dotIdx + 1) : ''
  const flowId = flowIdFromState || params.flowId || ''
  if (!flowId) {
    return { ok: false, message: 'missing flow_id (state unpack failed)' }
  }
  const flow = getFlow(flowId)
  if (!flow || flow.kind !== 'auth_code') {
    return { ok: false, message: 'unknown or expired flow' }
  }
  if (flow.expected_state !== pkceState) {
    // Some providers append "#..." into state — tolerate.
    if (!flow.expected_state || !params.state.includes(flow.expected_state)) {
      updateFlow(flowId, { status: 'error', error: 'state mismatch' })
      return { ok: false, message: 'state mismatch' }
    }
  }

  let tok: Record<string, unknown>
  try {
    if (flow.provider_id === 'claude-code') {
      tok = await claude.exchangeCode(
        params.code,
        flow.redirect_uri ?? '',
        flow.code_verifier ?? '',
        params.state,
      )
    } else if (flow.provider_id === 'codex') {
      tok = await codex.exchangeCode(
        params.code,
        flow.redirect_uri ?? '',
        flow.code_verifier ?? '',
      )
    } else {
      throw new Error('unsupported provider')
    }
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)
    updateFlow(flowId, { status: 'error', error: message })
    return { ok: false, message }
  }

  const expiresAt = tok.expires_in
    ? now() + Number(tok.expires_in)
    : null

  let accountId: string | null = null
  let accountLabel: string | null = null
  if (flow.provider_id === 'codex' && typeof tok.id_token === 'string') {
    const claims = decodeJwtClaims(tok.id_token)
    const oaiAuth = claims['https://api.openai.com/auth']
    if (oaiAuth && typeof oaiAuth === 'object') {
      const v = (oaiAuth as Record<string, unknown>).chatgpt_account_id
      if (typeof v === 'string') accountId = v
    }
    if (!accountId && typeof claims.chatgpt_account_id === 'string') {
      accountId = claims.chatgpt_account_id
    }
    if (typeof claims.email === 'string') accountLabel = claims.email
    else if (typeof claims.name === 'string') accountLabel = claims.name
  }

  saveToken({
    provider_id: flow.provider_id,
    access_token: String(tok.access_token),
    refresh_token:
      typeof tok.refresh_token === 'string' ? tok.refresh_token : null,
    expires_at: expiresAt,
    scope: typeof tok.scope === 'string' ? tok.scope : null,
    account_label: accountLabel,
    account_id: accountId,
  })
  updateFlow(flowId, {
    status: 'connected',
    account_label: accountLabel,
  })
  return {
    ok: true,
    message: `${flow.provider_id} connected. You can close this tab.`,
  }
}

async function pollDeviceCode(flowId: string): Promise<void> {
  let flow = getFlow(flowId) as FlowState | null
  if (!flow || flow.kind !== 'device_code' || !flow.device_code) return
  const interval = (flow.device_interval ?? 5) * 1000
  const deadline = (flow.device_expires_at ?? now() + 900) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval))
    flow = getFlow(flowId)
    if (!flow || flow.status !== 'pending') return
    let tok: Record<string, unknown> | null
    try {
      tok = await copilot.pollToken(flow.device_code ?? '')
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      updateFlow(flowId, { status: 'error', error: message })
      return
    }
    if (tok === null) continue
    const accessToken = String(tok.access_token)
    const label = await copilot.fetchAccountLabel(accessToken)
    saveToken({
      provider_id: flow.provider_id,
      access_token: accessToken,
      refresh_token:
        typeof tok.refresh_token === 'string' ? tok.refresh_token : null,
      expires_at: null,
      scope: typeof tok.scope === 'string' ? tok.scope : null,
      account_label: label,
      account_id: null,
    })
    updateFlow(flowId, { status: 'connected', account_label: label })
    return
  }
  updateFlow(flowId, { status: 'expired', error: 'device code expired' })
}

export function callbackHtml(ok: boolean, message: string): string {
  const color = ok ? '#10b981' : '#ef4444'
  const title = ok ? 'Connected' : 'Connection failed'
  const icon = ok ? '✓' : '✗'
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OpenHive — ${title}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; display:flex;
       align-items:center; justify-content:center; height:100vh; margin:0;
       background:#fafafa; color:#111; }
.card { max-width: 420px; padding:32px; text-align:center;
        border:1px solid #e5e5e5; border-radius:16px; background:white; }
.badge { display:inline-block; width:48px; height:48px; line-height:48px; border-radius:999px;
         background:${color}20; color:${color}; font-size:24px; font-weight:700; }
h1 { font-size:18px; margin:16px 0 8px; }
p { color:#666; margin:0; }
</style></head>
<body><div class="card">
  <div class="badge">${icon}</div>
  <h1>${title}</h1>
  <p>${message.replace(/</g, '&lt;')}</p>
</div>
<script>setTimeout(() => window.close(), 1500);</script>
</body></html>`
}
