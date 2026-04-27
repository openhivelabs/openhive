/**
 * Block binding refresher — called from the scheduler's tick.
 * Ports apps/server/openhive/panels/refresher.py.
 *
 * Walks every team's dashboard.yaml, finds blocks with `binding` fields
 * whose refresh interval has elapsed, executes the source + mapper, and
 * stores the result in panel_cache. Errors are captured per-block so one
 * broken binding doesn't poison the whole tick. An in-flight set prevents a
 * block from refreshing twice when ticks overlap.
 */

import { listCompanies } from '../companies'
import { loadDashboard } from '../dashboards'
import { extractCheckOptions, getTableCreateSql } from '../team-data'
import * as panelCache from './cache'
import { apply as applyMapper } from './mapper'
import { execute as executeSource, type SourceContext } from './sources'
import { synthesizeKanbanActions, synthesizeTableActions } from './synthesize'

/** Per-panel in-flight promise. When a refresh is already running we hand
 *  the same promise to subsequent callers instead of kicking off a parallel
 *  one — that avoids two concurrent writers stepping on each other and
 *  letting an older/slower call clobber a newer good result. */
const inflight = new Map<string, Promise<void>>()

export async function refreshDuePanels(): Promise<void> {
  const now = Date.now()
  const companies = listCompanies()
  for (const company of companies) {
    const companySlug = typeof company.slug === 'string' ? company.slug : null
    if (!companySlug) continue
    for (const team of company.teams ?? []) {
      const teamSlug = typeof team.slug === 'string' ? team.slug : null
      const teamId = typeof team.id === 'string' ? team.id : null
      if (!teamSlug || !teamId) continue
      const layout = loadDashboard(companySlug, teamSlug)
      if (!layout) continue
      const blocks = Array.isArray(layout.blocks) ? (layout.blocks as unknown[]) : []
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const block = raw as Record<string, unknown>
        const binding = block.binding
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue
        const panelId = String(block.id ?? '')
        if (!panelId || inflight.has(panelId)) continue

        if (!isDue(panelId, binding as Record<string, unknown>, now)) continue

        const ctx: SourceContext = {
          companySlug,
          teamSlug,
          teamId,
        }
        // Fire-and-forget per panel so slow sources don't serialise.
        void runRefresh(panelId, block, binding as Record<string, unknown>, teamId, ctx)
      }
    }
  }
}

function isDue(
  panelId: string,
  binding: Record<string, unknown>,
  nowMs: number,
): boolean {
  const refreshRaw = binding.refresh_seconds
  const refreshS = Number(refreshRaw)
  if (!Number.isFinite(refreshS) || refreshS <= 0) return false
  const cached = panelCache.get(panelId)
  if (!cached) return true
  const age = nowMs - cached.fetched_at
  return age >= refreshS * 1000
}

/** Coalesce concurrent calls — second caller awaits the first's promise. */
function runRefresh(
  panelId: string,
  block: Record<string, unknown>,
  binding: Record<string, unknown>,
  teamId: string,
  ctx: SourceContext,
): Promise<void> {
  const existing = inflight.get(panelId)
  if (existing) return existing
  const p = refreshOne(panelId, block, binding, teamId, ctx).finally(() => {
    inflight.delete(panelId)
  })
  inflight.set(panelId, p)
  return p
}

async function refreshOne(
  panelId: string,
  block: Record<string, unknown>,
  binding: Record<string, unknown>,
  teamId: string,
  ctx: SourceContext,
): Promise<void> {
  const start = performance.now()
  try {
    const raw = await executeSource(binding.source ?? {}, ctx)
    const panelType = typeof block.type === 'string' ? block.type : ''
    const shaped = applyMapper(
      raw,
      (binding.map as Record<string, unknown> | undefined) ?? {},
      panelType,
    )
    if (ctx.companySlug) {
      enrichKanbanTaxonomy(shaped, panelType, binding, ctx.companySlug)
      enrichSynthesizedActions(shaped, panelType, binding, ctx.companySlug)
    }
    const durationMs = Math.round(performance.now() - start)
    panelCache.upsertSuccess({
      panelId,
      teamId,
      data: shaped,
      durationMs,
    })
  } catch (exc) {
    const durationMs = Math.round(performance.now() - start)
    const name = exc instanceof Error ? exc.name : 'Error'
    const message = exc instanceof Error ? exc.message : String(exc)
    panelCache.upsertError({
      panelId,
      teamId,
      error: `${name}: ${message}`,
      durationMs,
    })
  }
}

export async function refreshOneNow(panelId: string): Promise<ReturnType<typeof panelCache.get>> {
  for (const company of listCompanies()) {
    const companySlug = typeof company.slug === 'string' ? company.slug : null
    if (!companySlug) continue
    for (const team of company.teams ?? []) {
      const teamSlug = typeof team.slug === 'string' ? team.slug : null
      const teamId = typeof team.id === 'string' ? team.id : null
      if (!teamSlug || !teamId) continue
      const layout = loadDashboard(companySlug, teamSlug)
      if (!layout) continue
      const blocks = Array.isArray(layout.blocks) ? (layout.blocks as unknown[]) : []
      for (const raw of blocks) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
        const block = raw as Record<string, unknown>
        if (String(block.id) !== panelId) continue
        const binding = block.binding
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
          return null
        }
        const ctx: SourceContext = {
          companySlug,
          teamSlug,
          teamId,
        }
        await runRefresh(panelId, block, binding as Record<string, unknown>, teamId, ctx)
        return panelCache.get(panelId)
      }
    }
  }
  return null
}

/** Attach `stage_taxonomy` to the shaped data of a kanban panel.
 *  KanbanView reads it to render every stage as its own column even when
 *  only some have rows. Two sources, in order:
 *    1. The binding's own `actions[].form.fields[name=group_by].options`
 *       (the kanban prompt requires this — works for any source kind).
 *    2. The team_data table's CHECK constraint on the group_by column —
 *       backstop for older bindings that don't declare options.
 *  Quietly no-ops for non-kanban panels. */
export function enrichKanbanTaxonomy(
  shaped: Record<string, unknown>,
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): void {
  if (panelType !== 'kanban') return
  const groupBy = (binding.map as { group_by?: unknown } | undefined)?.group_by
  if (typeof groupBy !== 'string' || groupBy.length === 0) return

  const fromBinding = stageOptionsFromBindingActions(binding, groupBy)
  if (fromBinding.length > 0) {
    shaped.stage_taxonomy = fromBinding
    return
  }

  const source = (binding.source ?? {}) as { kind?: unknown; config?: unknown }
  if (source.kind !== 'team_data') return
  const sql = String((source.config as { sql?: unknown } | undefined)?.sql ?? '')
  // Match the same FROM/JOIN regex the binder uses; first table is the
  // one whose schema actually owns the group_by column.
  const tableMatch = /\b(?:from|join)\s+["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?/i.exec(sql)
  const tableName = tableMatch?.[1]
  if (!tableName) return
  const createSql = getTableCreateSql(companySlug, tableName)
  if (!createSql) return
  const taxonomy = extractCheckOptions(createSql, groupBy)
  if (taxonomy.length > 0) shaped.stage_taxonomy = taxonomy
}

function stageOptionsFromBindingActions(
  binding: Record<string, unknown>,
  groupBy: string,
): string[] {
  const actions = binding.actions
  if (!Array.isArray(actions)) return []
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue
    const form = (a as { form?: unknown }).form as { fields?: unknown } | undefined
    const fields = form?.fields
    if (!Array.isArray(fields)) continue
    for (const f of fields) {
      if (!f || typeof f !== 'object') continue
      const fr = f as { name?: unknown; options?: unknown }
      if (fr.name !== groupBy) continue
      if (!Array.isArray(fr.options)) continue
      const opts = fr.options.filter((o): o is string => typeof o === 'string' && o.length > 0)
      if (opts.length > 0) return opts
    }
  }
  return []
}

/** Attach actions the binding doesn't carry but the panel type implies
 *  — today the kanban CRUD set (move, create, update, delete). The
 *  action objects are shipped to the client so the renderer knows which
 *  surfaces to draw (toolbar Add, drag-to-move, row Edit/Delete) and
 *  which IDs to invoke; the server resolves those same IDs by re-running
 *  the synthesis on the action endpoint. */
function enrichSynthesizedActions(
  shaped: Record<string, unknown>,
  panelType: string,
  binding: Record<string, unknown>,
  companySlug: string,
): void {
  const synthesized = [
    ...synthesizeKanbanActions(panelType, binding, companySlug),
    ...synthesizeTableActions(panelType, binding, companySlug),
  ]
  if (synthesized.length > 0) shaped.synthesized_actions = synthesized
}
