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
import * as panelCache from './cache'
import { apply as applyMapper } from './mapper'
import { execute as executeSource, type SourceContext } from './sources'

const inflight = new Set<string>()

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

        inflight.add(panelId)
        const ctx: SourceContext = {
          companySlug,
          teamSlug,
          teamId,
        }
        // Fire-and-forget per panel so slow sources don't serialise.
        void refreshOne(panelId, block, binding as Record<string, unknown>, teamId, ctx)
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
    const shaped = applyMapper(
      raw,
      (binding.map as Record<string, unknown> | undefined) ?? {},
      typeof block.type === 'string' ? block.type : '',
    )
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
  } finally {
    inflight.delete(panelId)
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
        await refreshOne(panelId, block, binding as Record<string, unknown>, teamId, ctx)
        return panelCache.get(panelId)
      }
    }
  }
  return null
}
