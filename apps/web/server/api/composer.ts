/**
 * Composer endpoints — the REST surface the dashboard AI chat + UI use to
 * ground itself on what's actually available.
 *
 * The LLM-facing tool wrappers (list_catalog / describe_table / sample_source /
 * propose_panel / commit_panel / edit_panel / delete_panel) are defined in
 * lib/server/composer/tools.ts (Stage 3). These HTTP endpoints are the subset
 * the UI calls directly: catalog for pickers, sample for live preview during
 * edit, etc.
 */

import { Hono } from 'hono'
import { composeOnce } from '@/lib/server/composer/tools'
import { loadDashboard, saveDashboard } from '@/lib/server/dashboards'
import { runExec } from '@/lib/server/team-data'
import { listCredentials } from '@/lib/server/credentials'
import { listMcpRegistry } from '@/lib/server/mcp-registry'
import { listMcpCatalog } from '@/lib/server/panels/mcp-catalog'
import { execute as executeSource } from '@/lib/server/panels/sources'
import { listTeamFiles } from '@/lib/server/panels/sources'
import { getRecipe, instantiateRecipe, listRecipes } from '@/lib/server/recipes'
import {
  describeSchema,
  describeTable,
} from '@/lib/server/team-data'
import { resolveTeamSlugs } from '@/lib/server/companies'

export const composer = new Hono()

// GET /api/composer/catalog?teamId=xxx
// Returns everything a panel composer can ground on: MCP servers + tools,
// team tables + schema, team files, credentials (meta only), recipes.
composer.get('/catalog', async (c) => {
  const teamId = c.req.query('teamId')
  let slugs: { companySlug: string; teamSlug: string } | null = null
  if (teamId) slugs = resolveTeamSlugs(teamId)
  const [mcp] = await Promise.all([listMcpCatalog()])
  let teamTables: unknown[] = []
  let teamFiles: string[] = []
  if (slugs) {
    try {
      teamTables = describeSchema(slugs.companySlug, slugs.teamSlug).tables
    } catch (e) {
      teamTables = [{ error: e instanceof Error ? e.message : String(e) }]
    }
    teamFiles = listTeamFiles(slugs.companySlug, slugs.teamSlug)
  }
  return c.json({
    mcp_servers: mcp,
    mcp_registry: listMcpRegistry(),
    team_tables: teamTables,
    team_files: teamFiles,
    credentials: listCredentials(),
    recipes: listRecipes(),
  })
})

// GET /api/composer/describe-table?teamId=xxx&table=yyy
composer.get('/describe-table', (c) => {
  const teamId = c.req.query('teamId')
  const table = c.req.query('table')
  if (!teamId || !table) {
    return c.json({ detail: 'teamId + table required' }, 400)
  }
  const slugs = resolveTeamSlugs(teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  try {
    return c.json(describeTable(slugs.companySlug, slugs.teamSlug, table))
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : String(e) }, 400)
  }
})

// POST /api/composer/install-recipe
// Body: { teamId, recipeId, params?, title? }
// Instantiates a recipe, assigns a new panel id, appends to dashboard.yaml.
composer.post('/install-recipe', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown
    recipeId?: unknown
    params?: unknown
    title?: unknown
  }
  if (typeof body.teamId !== 'string' || typeof body.recipeId !== 'string') {
    return c.json({ detail: 'teamId + recipeId required' }, 400)
  }
  const slugs = resolveTeamSlugs(body.teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  const recipe = getRecipe(body.recipeId)
  if (!recipe) return c.json({ detail: 'recipe not found' }, 404)
  const params =
    body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {}
  let panel: Record<string, unknown>
  try {
    panel = instantiateRecipe(recipe, params)
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : String(e) }, 400)
  }
  panel.id = `p-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
  if (typeof body.title === 'string' && body.title) panel.title = body.title
  // If the recipe ships setup DDL, run it once so the target table(s) exist
  // before the panel's read query fires. Idempotent CREATE TABLE IF NOT EXISTS
  // is the common shape; failures are surfaced so the user sees the reason.
  if (recipe.setup_sql) {
    try {
      for (const stmt of recipe.setup_sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
        runExec(slugs.companySlug, slugs.teamSlug, stmt, {
          source: `recipe:${recipe.id}`,
          note: 'setup_sql',
        })
      }
    } catch (e) {
      return c.json(
        { detail: `setup_sql failed: ${e instanceof Error ? e.message : String(e)}` },
        400,
      )
    }
  }
  const layout = loadDashboard(slugs.companySlug, slugs.teamSlug) ?? { blocks: [] }
  const blocks = Array.isArray(layout.blocks) ? (layout.blocks as Record<string, unknown>[]) : []
  blocks.push(panel)
  saveDashboard(slugs.companySlug, slugs.teamSlug, { ...layout, blocks })
  return c.json({ ok: true, panel })
})

// POST /api/composer/chat — primary entry for the dashboard AI dock.
// Body: { teamId, message } → returns the assistant's reply + what it did.
composer.post('/chat', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown
    message?: unknown
  }
  if (typeof body.teamId !== 'string' || typeof body.message !== 'string') {
    return c.json({ detail: 'teamId + message required' }, 400)
  }
  const msg = body.message.trim()
  if (!msg) return c.json({ detail: 'message empty' }, 400)
  try {
    const result = await composeOnce({ teamId: body.teamId, userMessage: msg })
    return c.json(result)
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// POST /api/composer/sample-source
// Body: { teamId, source: SourceSpec }
// Executes the source once and returns the raw response (truncated).
// Used by the AI composer to build a mapper against real data, and by the
// UI preview while editing a panel.
composer.post('/sample-source', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    teamId?: unknown
    source?: unknown
  }
  if (typeof body.teamId !== 'string' || !body.source) {
    return c.json({ detail: 'teamId + source required' }, 400)
  }
  const slugs = resolveTeamSlugs(body.teamId)
  if (!slugs) return c.json({ detail: 'team not found' }, 404)
  try {
    const data = await executeSource(body.source, {
      companySlug: slugs.companySlug,
      teamSlug: slugs.teamSlug,
      teamId: body.teamId,
    })
    // Cap at 8KB to keep AI context bounded; UI gets a truncated flag.
    const serialized = JSON.stringify(data)
    const CAP = 8 * 1024
    if (serialized.length > CAP) {
      return c.json({
        truncated: true,
        sample: JSON.parse(serialized.slice(0, CAP).replace(/,?[^,}]*$/, '')) ?? null,
        size_bytes: serialized.length,
      })
    }
    return c.json({ truncated: false, sample: data, size_bytes: serialized.length })
  } catch (e) {
    return c.json({ detail: e instanceof Error ? e.message : String(e) }, 400)
  }
})
