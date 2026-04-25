import { Hono } from 'hono'
import { listConnected } from '@/lib/server/tokens'
import { installAgentFrame } from '@/lib/server/agent-frames'
import { installFrame } from '@/lib/server/frames'
import { loadDashboard, saveDashboard } from '@/lib/server/dashboards'
import { aiBindPanel } from '@/lib/server/panels/ai-bind'
import { acquireInstallLock } from '@/lib/server/panels/install-lock'
import { buildInstallPlan } from '@/lib/server/panels/install-plan'
import { apply as applyMapper } from '@/lib/server/panels/mapper'
import { execute as executeSource } from '@/lib/server/panels/sources'
import { resolveTeamSlugs } from '@/lib/server/companies'
import { describeSchema, runExec } from '@/lib/server/team-data'
import {
  type MarketType,
  fetchMarketFrame,
  fetchMarketIndex,
} from '@/lib/server/market'

export const market = new Hono()

// GET /api/market — remote catalog (companies / teams / agents + warnings)
market.get('/', async (c) => c.json(await fetchMarketIndex()))

interface InstallBody {
  type?: MarketType
  id?: string
  target_company_slug?: string
  target_team_slug?: string
  /** Required for `type=panel` — category subdirectory in the remote repo. */
  category?: string
}

// POST /api/market/install — legacy non-panel installer (team/agent/company).
// Panel installs go through /install/preview + /install/apply so the AI
// router can inspect the current schema first.
market.post('/install', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as InstallBody
  const type = body.type
  const id = body.id
  if (!type || !id) {
    return c.json({ detail: 'type and id required' }, 400)
  }
  if (type === 'team') {
    const targetCompany = body.target_company_slug
    if (!targetCompany) {
      return c.json({ detail: 'target_company_slug required for team' }, 400)
    }
    try {
      const frame = await fetchMarketFrame('team', id)
      const result = installFrame(targetCompany, frame, {
        connectedProviders: new Set(listConnected()),
      })
      return c.json({ type, id, ...result })
    } catch (err) {
      const code = (err as { code?: string }).code
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ detail: message }, code === 'ENOENT' ? 404 : 400)
    }
  }
  if (type === 'agent') {
    const targetCompany = body.target_company_slug
    const targetTeam = body.target_team_slug
    if (!targetCompany || !targetTeam) {
      return c.json(
        { detail: 'target_company_slug and target_team_slug required for agent' },
        400,
      )
    }
    try {
      const frame = await fetchMarketFrame('agent', id)
      const result = installAgentFrame(targetCompany, targetTeam, frame)
      return c.json({ type, id, ...result })
    } catch (err) {
      const code = (err as { code?: string }).code
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ detail: message }, code === 'ENOENT' ? 404 : 400)
    }
  }
  if (type === 'panel') {
    return c.json(
      {
        detail:
          'panel installs are two-phase — POST /install/preview first, then /install/apply with the chosen decision',
      },
      400,
    )
  }
  if (type === 'company') {
    return c.json(
      {
        detail:
          'company-frame install not implemented yet — unpack the bundle manifest client-side and install each team frame into a new company.',
      },
      501,
    )
  }
  return c.json({ detail: `unknown type: ${String(type)}` }, 400)
})

// ─── Panel two-phase install ──────────────────────────────────────────

interface PanelInstallBody {
  id?: string
  target_company_slug?: string
  target_team_slug?: string
  target_team_id?: string
  category?: string
}

interface PanelApplyBody extends PanelInstallBody {
  decision?: 'reuse' | 'extend' | 'standalone'
  alter_sql?: string[]
  skip_create_tables?: string[]
  user_intent?: string | null
  /** Optional binding produced by an earlier `/install/ai-bind-preview` call.
   *  When present we skip the (expensive) AI call here and trust the client's
   *  preview-validated binding. */
  prebuilt_binding?: Record<string, unknown> | null
  /** User-chosen footprint on the dashboard grid. Overrides the frame
   *  manifest's default size. */
  col_span?: number
  row_span?: number
}

// Shared: fetch panel frame + extract setup_sql + panel body.
async function fetchPanelFrameParts(
  id: string,
  category: string | undefined,
): Promise<{
  setupSql: string | undefined
  panel: Record<string, unknown>
  description: string | undefined
}> {
  if (!category) throw new Error('category required for panel install')
  const frame = (await fetchMarketFrame('panel', id, category)) as
    | Record<string, unknown>
    | null
  if (!frame || typeof frame !== 'object') {
    throw new Error('invalid panel frame')
  }
  const panelRaw = (frame as { panel?: unknown }).panel ?? frame
  if (!panelRaw || typeof panelRaw !== 'object') {
    throw new Error('panel frame missing `panel` body')
  }
  const setupSqlVal = (frame as { setup_sql?: unknown }).setup_sql
  const setupSql =
    typeof setupSqlVal === 'string' && setupSqlVal.trim() ? setupSqlVal : undefined
  const descVal =
    (frame as { description?: unknown }).description ??
    (panelRaw as { description?: unknown }).description
  const description = typeof descVal === 'string' ? descVal : undefined
  return {
    setupSql,
    panel: JSON.parse(JSON.stringify(panelRaw)) as Record<string, unknown>,
    description,
  }
}

function extractPanelSql(panel: Record<string, unknown>): string | undefined {
  const binding = (panel.binding as Record<string, unknown> | undefined) ?? {}
  const source = (binding.source as Record<string, unknown> | undefined) ?? {}
  if (source.kind !== 'team_data') return undefined
  const config = (source.config as Record<string, unknown> | undefined) ?? {}
  const sql = config.sql
  return typeof sql === 'string' ? sql : undefined
}

// POST /api/market/install/preview
// Body: { id, target_company_slug, target_team_slug, target_team_id, category }
// Returns: { plan: InstallPlan, panel_id, panel_title } — no DB writes.
market.post('/install/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PanelInstallBody
  if (!body.id || !body.target_company_slug || !body.target_team_id) {
    return c.json(
      { detail: 'id, target_company_slug, target_team_id required' },
      400,
    )
  }
  try {
    const { setupSql, panel } = await fetchPanelFrameParts(
      body.id,
      body.category,
    )
    const panelSql = extractPanelSql(panel)
    const plan = buildInstallPlan({
      companySlug: body.target_company_slug,
      teamId: body.target_team_id,
      setupSql,
      panelSql,
    })
    return c.json({
      plan,
      panel_title: panel.title ?? null,
      setup_sql: setupSql ?? null,
      panel_sql: panelSql ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
})

// POST /api/market/install/apply
// Body: { id, target_company_slug, target_team_slug, target_team_id,
//         category, decision, alter_sql?, skip_create_tables? }
// Executes the chosen plan variant in a single transaction.
market.post('/install/apply', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PanelApplyBody
  const {
    id,
    target_company_slug: targetCompany,
    target_team_slug: targetTeam,
    target_team_id: teamId,
    decision,
  } = body
  if (!id || !targetCompany || !targetTeam || !teamId) {
    return c.json(
      { detail: 'id, target_company_slug, target_team_slug, target_team_id required' },
      400,
    )
  }
  const finalDecision = decision ?? 'standalone'
  // Serialize installs per team so concurrent calls can't race on
  // schema state. Preview is lock-free; apply is not. Release in
  // finally so a thrown install doesn't wedge future installs.
  const release = await acquireInstallLock(teamId)
  try {
    const { setupSql, panel, description } = await fetchPanelFrameParts(
      id,
      body.category,
    )
    const skipCreateTables = new Set(body.skip_create_tables ?? [])

    // AI binding route — runs whenever the user expressed an intent OR the
    // team already has tables. Skips setup_sql (we map onto existing schema
    // instead of creating new tables) and replaces the manifest binding with
    // an AI-generated one. The deterministic install-plan path below is only
    // reached when intent is empty AND the team is a blank canvas.
    const userIntent =
      typeof body.user_intent === 'string' && body.user_intent.trim().length > 0
        ? body.user_intent.trim()
        : null
    const schema = (() => {
      try {
        return describeSchema(targetCompany, { teamId })
      } catch {
        return { tables: [], recent_migrations: [] }
      }
    })()
    const useAi = userIntent !== null || (schema.tables?.length ?? 0) > 0

    if (useAi) {
      // Trust the prebuilt binding from a prior preview call when present —
      // the user already saw it render in the modal preview, no point re-asking
      // the LLM and risking a different answer.
      const binding =
        body.prebuilt_binding && typeof body.prebuilt_binding === 'object'
          ? body.prebuilt_binding
          : ((await aiBindPanel({
              panel,
              description,
              schema,
              userIntent,
            })) as unknown as Record<string, unknown>)
      panel.binding = binding
    } else {
      // 1) Run ALTERs for `extend`, then setup.sql filtered by skip list.
      if (finalDecision === 'extend' && body.alter_sql && body.alter_sql.length > 0) {
        for (const stmt of body.alter_sql) {
          if (!stmt.trim()) continue
          try {
            runExec(targetCompany, stmt, {
              source: `panel-install:${id}`,
              note: `extend for ${id}`,
              teamId,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (!/duplicate column|already exists/i.test(msg)) throw e
          }
        }
      }

      if (finalDecision !== 'reuse' && setupSql) {
        for (const stmt of splitStatements(setupSql)) {
          if (!stmt.trim()) continue
          if (shouldSkipCreate(stmt, skipCreateTables)) continue
          try {
            runExec(targetCompany, stmt, {
              source: `panel-install:${id}`,
              note: `setup_sql for ${id}`,
              teamId,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            if (!/already exists|duplicate column/i.test(msg)) throw e
          }
        }
      }
    }

    // 2) Add the panel to the team's dashboard.
    panel.id = `p-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
    if (typeof body.col_span === 'number') {
      panel.colSpan = Math.min(6, Math.max(1, Math.floor(body.col_span)))
    }
    if (typeof body.row_span === 'number') {
      panel.rowSpan = Math.min(6, Math.max(1, Math.floor(body.row_span)))
    }
    const layout = loadDashboard(targetCompany, targetTeam) ?? { blocks: [] }
    const blocks = Array.isArray(layout.blocks)
      ? (layout.blocks as Record<string, unknown>[])
      : []
    blocks.push(panel)
    saveDashboard(targetCompany, targetTeam, { ...layout, blocks })

    return c.json({ ok: true, panel, decision: finalDecision })
  } catch (err) {
    const code = (err as { code?: string }).code
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, code === 'ENOENT' ? 404 : 400)
  } finally {
    release()
  }
})

// POST /api/market/install/ai-bind-preview
// Returns { binding, panel_type, data } — runs the AI binder against the team's
// current schema and executes the binding once so the modal can render a live
// preview before the user commits to install.
market.post('/install/ai-bind-preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as PanelInstallBody & {
    user_intent?: string | null
  }
  if (!body.id || !body.target_company_slug || !body.target_team_id) {
    return c.json(
      { detail: 'id, target_company_slug, target_team_id required' },
      400,
    )
  }
  try {
    const { panel, description } = await fetchPanelFrameParts(
      body.id,
      body.category,
    )
    const targetCompany = body.target_company_slug
    const teamId = body.target_team_id
    const userIntent =
      typeof body.user_intent === 'string' && body.user_intent.trim().length > 0
        ? body.user_intent.trim()
        : null
    const schema = (() => {
      try {
        return describeSchema(targetCompany, { teamId })
      } catch {
        return { tables: [], recent_migrations: [] }
      }
    })()
    const binding = await aiBindPanel({
      panel,
      description,
      schema,
      userIntent,
    })
    const panelType = String(panel.type ?? '')
    const resolved = resolveTeamSlugs(teamId)
    if (!resolved) {
      return c.json({ detail: 'team not found' }, 404)
    }
    const ctx = {
      companySlug: resolved.companySlug,
      teamSlug: resolved.teamSlug,
      teamId,
    }
    let data: unknown = null
    let execError: string | null = null
    try {
      const raw = await executeSource(
        binding.source as unknown as Record<string, unknown>,
        ctx,
      )
      data = applyMapper(
        raw,
        binding.map as unknown as Record<string, unknown>,
        panelType,
      )
    } catch (exc) {
      execError = exc instanceof Error ? exc.message : String(exc)
    }
    const panelProps =
      typeof panel.props === 'object' && panel.props !== null
        ? (panel.props as Record<string, unknown>)
        : null
    return c.json({
      binding,
      panel_type: panelType,
      panel_props: panelProps,
      data,
      error: execError,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ detail: message }, 400)
  }
})

function splitStatements(sql: string): string[] {
  // Naive but fine for our seed DDL: split on `;` at top level (no strings
  // in our CREATE TABLEs). For paranoia, strip any empty chunks.
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function shouldSkipCreate(stmt: string, skipNames: Set<string>): boolean {
  if (skipNames.size === 0) return false
  const m = stmt.match(
    /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/i,
  )
  if (!m) return false
  return skipNames.has(m[1]!)
}
