import { getFlow } from '@/lib/server/auth/flows'
import { callbackHtml, handleCallback, startConnect } from '@/lib/server/auth/orchestrator'
import { PROVIDERS, getProvider } from '@/lib/server/auth/providers'
import { clearProviderCache } from '@/lib/server/providers/cache-control'
import { listModelsFor } from '@/lib/server/providers/models'
import { deleteToken, getAccountLabel, listConnected, saveToken } from '@/lib/server/tokens'
import { Hono } from 'hono'

export const providers = new Hono()

/** Phase rollout gating — `OPENHIVE_PROVIDER_<UPPER>=0` hides a provider
 *  from the UI list. Default is shown for everyone (post-rollout state).
 *  Already-connected providers are always shown so users can disconnect
 *  even after a flag flip. */
function isProviderEnabled(providerId: string, alreadyConnected: boolean): boolean {
  if (alreadyConnected) return true
  const flag = process.env[`OPENHIVE_PROVIDER_${providerId.replace(/-/g, '_').toUpperCase()}`]
  if (flag === undefined) return true // default-on
  return flag === '1' || flag.toLowerCase() === 'true' || flag.toLowerCase() === 'on'
}

// GET /api/providers — list all providers with connection status
providers.get('/', (c) => {
  const connected = new Set(listConnected())
  return c.json(
    PROVIDERS.filter((p) => isProviderEnabled(p.id, connected.has(p.id))).map((p) => ({
      id: p.id,
      label: p.label,
      kind: p.kind,
      description: p.description,
      connected: connected.has(p.id),
      account_label: connected.has(p.id) ? getAccountLabel(p.id) : null,
    })),
  )
})

// GET /api/providers/oauth/callback — OAuth redirect landing page.
// Must be registered BEFORE `/:providerId/...` so Hono doesn't treat
// "oauth" as a providerId.
providers.get('/oauth/callback', async (c) => {
  const url = new URL(c.req.url)
  const params = url.searchParams
  const result = await handleCallback({
    code: params.get('code'),
    state: params.get('state'),
    flowId: params.get('flow_id'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  })
  return new Response(callbackHtml(result.ok, result.message), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
})

// DELETE /api/providers/:providerId — disconnect
providers.delete('/:providerId', (c) => {
  const providerId = c.req.param('providerId')
  if (!getProvider(providerId)) {
    return c.json({ detail: 'unknown provider' }, 404)
  }
  const removed = deleteToken(providerId)
  // Drop in-memory caches (auth tokens, parsed service-account, etc.)
  // so a fresh credential isn't shadowed when the user reconnects with
  // a different key.
  clearProviderCache(providerId)
  return c.json({ removed })
})

// GET /api/providers/:providerId/models
providers.get('/:providerId/models', async (c) => {
  const providerId = c.req.param('providerId')
  if (!getProvider(providerId)) {
    return c.json({ detail: 'unknown provider' }, 404)
  }
  try {
    return c.json(await listModelsFor(providerId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 500)
  }
})

// POST /api/providers/:providerId/connect/key — API-key providers
providers.post('/:providerId/connect/key', async (c) => {
  const providerId = c.req.param('providerId')
  const def = getProvider(providerId)
  if (!def) return c.json({ detail: 'unknown provider' }, 404)
  if (def.kind !== 'api_key') return c.json({ detail: 'not an api_key provider' }, 400)
  const body = (await c.req.json().catch(() => null)) as { api_key?: string; label?: string } | null
  const key = body?.api_key?.trim()
  if (!key) return c.json({ detail: 'api_key required' }, 400)
  saveToken({
    provider_id: providerId,
    access_token: key,
    refresh_token: null,
    expires_at: null,
    scope: null,
    account_label: body?.label?.trim() || def.label,
    account_id: null,
  })
  return c.json({ ok: true, account_label: body?.label?.trim() || def.label })
})

// POST /api/providers/:providerId/connect/start
providers.post('/:providerId/connect/start', async (c) => {
  const providerId = c.req.param('providerId')
  if (!getProvider(providerId)) {
    return c.json({ detail: 'unknown provider' }, 404)
  }
  // Pass the request origin; orchestrator decides the path per provider
  // (Claude `/callback`, Codex `/auth/callback`) to match the paths their
  // shared CLI client_ids expect. `127.0.0.1` in the raw url → normalise
  // to `localhost` because Anthropic/OpenAI whitelists the hostname
  // `localhost`, not the IP literal.
  const raw = new URL(c.req.url)
  const host = raw.hostname === '127.0.0.1' ? 'localhost' : raw.hostname
  const origin = `${raw.protocol}//${host}${raw.port ? `:${raw.port}` : ''}`
  try {
    return c.json(await startConnect(providerId, origin))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
})

// GET /api/providers/:providerId/connect/status?flow_id=...
providers.get('/:providerId/connect/status', (c) => {
  const providerId = c.req.param('providerId')
  const flowId = c.req.query('flow_id')
  if (!flowId) {
    return c.json({ detail: 'flow_id required' }, 400)
  }
  const flow = getFlow(flowId)
  if (!flow || flow.provider_id !== providerId) {
    return c.json({ detail: 'flow not found' }, 404)
  }
  return c.json({
    status: flow.status,
    error: flow.error,
    account_label: flow.account_label ?? null,
  })
})
