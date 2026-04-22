import { getFlow } from '@/lib/server/auth/flows'
import { callbackHtml, handleCallback, startConnect } from '@/lib/server/auth/orchestrator'
import { PROVIDERS, getProvider } from '@/lib/server/auth/providers'
import { listModelsFor } from '@/lib/server/providers/models'
import { deleteToken, getAccountLabel, listConnected } from '@/lib/server/tokens'
import { Hono } from 'hono'

export const providers = new Hono()

// GET /api/providers — list all providers with connection status
providers.get('/', (c) => {
  const connected = new Set(listConnected())
  return c.json(
    PROVIDERS.map((p) => ({
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
  return c.json({ removed: deleteToken(providerId) })
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

// POST /api/providers/:providerId/connect/start
providers.post('/:providerId/connect/start', async (c) => {
  const providerId = c.req.param('providerId')
  if (!getProvider(providerId)) {
    return c.json({ detail: 'unknown provider' }, 404)
  }
  // Build the callback URI from the current request origin. Matches the Python
  // side which used `request.base_url` — so redirect URIs consistently point
  // at the host the browser reached, whatever port/hostname that is.
  const origin = new URL(c.req.url).origin
  const callbackUri = `${origin}/api/providers/oauth/callback`
  try {
    return c.json(await startConnect(providerId, callbackUri))
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
