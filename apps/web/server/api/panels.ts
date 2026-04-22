import { resolveTeamSlugs } from '@/lib/server/companies'
import { loadDashboard } from '@/lib/server/dashboards'
import {
  type PanelActionSpec,
  executeAction,
  ActionError,
} from '@/lib/server/panels/actions'
import { get } from '@/lib/server/panels/cache'
import { refreshOneNow } from '@/lib/server/panels/refresher'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

export const panels = new Hono()

const POLL_INTERVAL_MS = 1000

// GET /api/panels/:panelId/data
panels.get('/:panelId/data', (c) => {
  const panelId = c.req.param('panelId')
  const row = get(panelId)
  if (!row) {
    return c.json({
      panel_id: panelId,
      data: null,
      error: null,
      fetched_at: null,
    })
  }
  return c.json(row)
})

// POST /api/panels/:panelId/actions/:actionId
// Body: { teamId: string, values: Record<string, unknown> }
panels.post('/:panelId/actions/:actionId', async (c) => {
  const panelId = c.req.param('panelId')
  const actionId = c.req.param('actionId')
  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown
    values?: unknown
  }
  if (typeof body.teamId !== 'string') {
    return c.json({ detail: 'teamId required' }, 400)
  }
  const values =
    body.values && typeof body.values === 'object' && !Array.isArray(body.values)
      ? (body.values as Record<string, unknown>)
      : {}
  const slugs = resolveTeamSlugs(body.teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  const layout = loadDashboard(slugs.companySlug, slugs.teamSlug)
  if (!layout) return c.json({ detail: 'dashboard not found' }, 404)

  const blocks = Array.isArray(layout.blocks) ? (layout.blocks as Record<string, unknown>[]) : []
  const panel = blocks.find((b) => b && b.id === panelId)
  if (!panel) return c.json({ detail: 'panel not found' }, 404)
  const binding = panel.binding as { actions?: PanelActionSpec[] } | undefined
  const action = binding?.actions?.find((a) => a.id === actionId)
  if (!action) return c.json({ detail: 'action not found' }, 404)

  try {
    const result = await executeAction(
      { companySlug: slugs.companySlug, teamSlug: slugs.teamSlug, teamId: body.teamId },
      panelId,
      action,
      values,
    )
    return c.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = e instanceof ActionError ? 400 : 500
    return c.json({ ok: false, detail: msg }, status)
  }
})

// POST /api/panels/:panelId/refresh
panels.post('/:panelId/refresh', async (c) => {
  const panelId = c.req.param('panelId')
  const result = await refreshOneNow(panelId)
  if (!result) {
    return c.json({ detail: 'block not found or has no binding' }, 404)
  }
  return c.json(result)
})

/**
 * SSE stream that pushes the panel's cache row whenever its fetched_at
 * advances. Polling the DB every ~1s is cheap and avoids wiring a
 * cross-process pubsub just for this UI feature.
 */
panels.get('/:panelId/stream', (c) => {
  const panelId = c.req.param('panelId')
  // Hono sets text/event-stream + no-cache automatically via streamSSE.
  // Add X-Accel-Buffering to mirror the Next handler's behavior behind proxies.
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(c, async (stream) => {
    let aborted = false
    stream.onAbort(() => {
      aborted = true
    })

    let lastTs: number | null = null
    const initial = get(panelId)
    if (initial) {
      lastTs = initial.fetched_at
      await stream.writeSSE({ data: JSON.stringify(initial) })
    }
    while (!aborted) {
      await stream.sleep(POLL_INTERVAL_MS)
      if (aborted) break
      const row = get(panelId)
      if (!row) continue
      if (lastTs === null || row.fetched_at > lastTs) {
        lastTs = row.fetched_at
        await stream.writeSSE({ data: JSON.stringify(row) })
      }
    }
  })
})
