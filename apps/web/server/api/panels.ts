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
