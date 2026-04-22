import { Hono } from 'hono'
import {
  addApiKey,
  deleteCredential,
  listCredentials,
} from '@/lib/server/credentials'

export const credentials = new Hono()

// GET /api/credentials — list (meta only, never the value)
credentials.get('/', (c) => c.json({ credentials: listCredentials() }))

// POST /api/credentials — add an API key
credentials.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    ref_id?: unknown
    value?: unknown
    label?: unknown
    scopes?: unknown
  }
  if (typeof body.ref_id !== 'string' || typeof body.value !== 'string') {
    return c.json({ detail: 'ref_id + value required (strings)' }, 400)
  }
  try {
    const meta = addApiKey({
      ref_id: body.ref_id,
      value: body.value,
      label: typeof body.label === 'string' ? body.label : undefined,
      scopes: Array.isArray(body.scopes)
        ? body.scopes.filter((s): s is string => typeof s === 'string')
        : undefined,
    })
    return c.json({ credential: meta })
  } catch (err) {
    return c.json({ detail: err instanceof Error ? err.message : String(err) }, 400)
  }
})

// DELETE /api/credentials/:ref_id
credentials.delete('/:refId', (c) => {
  const ok = deleteCredential(c.req.param('refId'))
  if (!ok) return c.json({ detail: 'not found' }, 404)
  return c.json({ ok: true })
})
