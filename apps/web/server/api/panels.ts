import { resolveTeamSlugs } from '@/lib/server/companies'
import { loadDashboard } from '@/lib/server/dashboards'
import { aiBindPanel } from '@/lib/server/panels/ai-bind'
import {
  type PanelActionSpec,
  executeAction,
  ActionError,
} from '@/lib/server/panels/actions'
import { synthesizeKanbanActions } from '@/lib/server/panels/synthesize'
import { getMemo, setMemo } from '@/lib/server/panels/memos'
import { get } from '@/lib/server/panels/cache'
import { apply as applyMapper } from '@/lib/server/panels/mapper'
import { enrichKanbanTaxonomy, refreshOneNow } from '@/lib/server/panels/refresher'
import { execute as executeSource } from '@/lib/server/panels/sources'
import { describeSchema, dryRunWithSetup } from '@/lib/server/team-data'

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)
}
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

export const panels = new Hono()

const POLL_INTERVAL_MS = 1000

interface PreviewBody {
  team_id?: string
  panel_type?: string
  binding?: Record<string, unknown>
}

// POST /api/panels/preview
// Run a draft binding against a team's data without persisting anything.
// Used by the panel edit modal to show a live preview of the user's edit.
panels.post('/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PreviewBody
  if (typeof body.team_id !== 'string' || !body.team_id) {
    return c.json({ detail: 'team_id required' }, 400)
  }
  if (typeof body.panel_type !== 'string' || !body.panel_type) {
    return c.json({ detail: 'panel_type required' }, 400)
  }
  if (!body.binding || typeof body.binding !== 'object') {
    return c.json({ detail: 'binding required' }, 400)
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return c.json({ detail: 'team not found' }, 404)
  }
  const ctx = {
    companySlug: resolved.companySlug,
    teamSlug: resolved.teamSlug,
    teamId: body.team_id,
  }
  try {
    const raw = await executeSource(body.binding.source ?? {}, ctx)
    const shaped = applyMapper(
      raw,
      (body.binding.map as Record<string, unknown> | undefined) ?? {},
      body.panel_type,
    )
    enrichKanbanTaxonomy(shaped, body.panel_type, body.binding, ctx.companySlug)
    return c.json({ ok: true, data: shaped })
  } catch (exc) {
    const name = exc instanceof Error ? exc.name : 'Error'
    const message = exc instanceof Error ? exc.message : String(exc)
    return c.json({ ok: false, error: `${name}: ${message}` })
  }
})

// POST /api/panels/rebind
// Body: { team_id, spec: PanelSpec, user_intent }
// Re-runs the AI binder against the team's current schema using an existing
// panel spec as the skeleton. Returns the new binding + a one-shot executed
// preview, so the edit modal can show what the rebound panel will look like
// before the user saves.
panels.post('/rebind', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    team_id?: string
    spec?: Record<string, unknown>
    user_intent?: string | null
  }
  if (!body.team_id || !body.spec || typeof body.spec !== 'object') {
    return c.json({ detail: 'team_id and spec required' }, 400)
  }
  const resolved = resolveTeamSlugs(body.team_id)
  if (!resolved) {
    return c.json({ detail: 'team not found' }, 404)
  }
  const userIntent =
    typeof body.user_intent === 'string' && body.user_intent.trim().length > 0
      ? body.user_intent.trim()
      : null
  const schema = (() => {
    try {
      return describeSchema(resolved.companySlug, { teamId: body.team_id })
    } catch {
      return { tables: [], recent_migrations: [] }
    }
  })()
  try {
    const aiResult = await aiBindPanel({
      panel: body.spec,
      schema,
      userIntent,
    })
    const binding = aiResult.binding
    const panelType = String((body.spec as { type?: unknown }).type ?? '')
    const ctx = {
      companySlug: resolved.companySlug,
      teamSlug: resolved.teamSlug,
      teamId: body.team_id,
    }
    let data: unknown = null
    let execError: string | null = null
    try {
      // Dry-run rebind preview when the AI emitted setup_sql, so the
      // proposed-but-not-yet-applied schema doesn't pollute the live DB
      // on every preview tick.
      if (
        aiResult.setupSql &&
        (binding.source as { kind?: unknown } | undefined)?.kind === 'team_data'
      ) {
        const sql = String(
          ((binding.source as { config?: { sql?: unknown } }).config?.sql) ?? '',
        )
        const setupStmts = splitStatements(aiResult.setupSql)
        const result = dryRunWithSetup(resolved.companySlug, setupStmts, sql, {
          teamId: body.team_id,
        })
        data = applyMapper(
          result,
          binding.map as unknown as Record<string, unknown>,
          panelType,
        )
      } else {
        const raw = await executeSource(
          binding.source as unknown as Record<string, unknown>,
          ctx,
        )
        data = applyMapper(
          raw,
          binding.map as unknown as Record<string, unknown>,
          panelType,
        )
      }
    } catch (exc) {
      execError = exc instanceof Error ? exc.message : String(exc)
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      enrichKanbanTaxonomy(
        data as Record<string, unknown>,
        panelType,
        binding as unknown as Record<string, unknown>,
        ctx.companySlug,
      )
    }
    return c.json({ binding, panel_type: panelType, data, error: execError })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 502)
  }
})

// GET /api/panels/:panelId/memo?teamId=...
panels.get('/:panelId/memo', (c) => {
  const panelId = c.req.param('panelId')
  const teamId = c.req.query('teamId')
  if (typeof teamId !== 'string' || !teamId) {
    return c.json({ detail: 'teamId required' }, 400)
  }
  const slugs = resolveTeamSlugs(teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  return c.json(getMemo(slugs.companySlug, teamId, panelId))
})

// PUT /api/panels/:panelId/memo
// Body: { teamId: string, content: string }
panels.put('/:panelId/memo', async (c) => {
  const panelId = c.req.param('panelId')
  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown
    content?: unknown
  }
  if (typeof body.teamId !== 'string' || !body.teamId) {
    return c.json({ detail: 'teamId required' }, 400)
  }
  const content = typeof body.content === 'string' ? body.content : ''
  const slugs = resolveTeamSlugs(body.teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  return c.json(setMemo(slugs.companySlug, body.teamId, panelId, content))
})

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
  const persistedAction = binding?.actions?.find((a) => a.id === actionId)
  // Fall back to synthesized actions (e.g. kanban move on bindings that
  // don't carry an explicit drag update) so drag-to-move still works
  // without requiring a re-bind. refresher attaches the same synthesis
  // to panel data so client and server agree on which IDs are valid.
  // Fall back to synthesized actions (e.g. kanban CRUD on bindings that
  // don't carry explicit actions) so users can add/edit/move/delete
  // without requiring a re-bind. refresher attaches the same synthesis
  // to panel data so client and server agree on which IDs are valid.
  let action: PanelActionSpec | null = persistedAction ?? null
  if (!action && typeof panel.type === 'string') {
    const synthesized = synthesizeKanbanActions(
      panel.type,
      (panel.binding ?? {}) as Record<string, unknown>,
      slugs.companySlug,
    )
    const match = synthesized.find((a) => a.id === actionId)
    if (match) action = match as unknown as PanelActionSpec
  }
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
