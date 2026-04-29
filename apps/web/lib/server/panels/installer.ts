/**
 * Chat-callable installer wrappers. Sit on top of the same primitives the
 * UI install handler uses (server/api/market.ts), but expose a smaller,
 * chat-friendly API:
 *
 *   - `installPanelStandalone()` — register a panel onto the dashboard with
 *     its frame's manifest binding, run setup_sql idempotently, no AI bind.
 *     Use when the chat agent picks a frame from the market and just wants
 *     it on the dashboard. AI binding is a separate `rebindPanelInLayout()`
 *     call so the chat round budget isn't burned on a 5–30s LLM step that
 *     may fail and need retry.
 *
 *   - `rebindPanelInLayout()` — re-run the AI binder against the team's
 *     current schema for a single existing panel and persist the resulting
 *     binding. Mirrors what the dashboard UI's "Rebind" modal does, but
 *     scoped to the chat tool surface.
 *
 *   - `deletePanelFromLayout()` — remove a panel from dashboard.yaml and
 *     drop its cache entry. Soft delete; the underlying data table is
 *     preserved (other panels may reference it).
 *
 *   - `patchPanelInLayout()` — apply a partial update to a single panel
 *     (col/row/colSpan/rowSpan/props/binding) and persist.
 *
 * All functions acquire the per-team install-lock around mutations so they
 * can't race with concurrent UI installs.
 */

import { loadDashboard, saveDashboard } from '../dashboards'
import { describeSchema, runExec } from '../team-data'
import { aiBindPanel } from './ai-bind'
import { deleteCache } from './cache'
import {
  clampSpan,
  fetchPanelFrameParts,
  newPanelId,
  shouldSkipCreate,
  splitStatements,
} from './install-helpers'
import { acquireInstallLock } from './install-lock'

interface CommonCtx {
  companySlug: string
  teamSlug: string
  teamId: string
}

export interface InstallStandaloneInput extends CommonCtx {
  frameId: string
  category: string
  colSpan?: number
  rowSpan?: number
}

export interface InstallStandaloneResult {
  ok: true
  panel: Record<string, unknown>
  decision: 'standalone'
}

/**
 * Install a panel frame onto the team's dashboard with its manifest binding
 * and setup_sql, no AI binder. Idempotent against pre-existing tables (errors
 * matching `already exists`/`duplicate column` are swallowed). Caller should
 * run `rebindPanelInLayout` afterwards if they want a fresh AI-generated
 * binding tailored to the user's intent.
 */
export async function installPanelStandalone(
  input: InstallStandaloneInput,
): Promise<InstallStandaloneResult> {
  const release = await acquireInstallLock(input.teamId)
  try {
    const { setupSql, panel } = await fetchPanelFrameParts(
      input.frameId,
      input.category,
    )

    if (setupSql) {
      for (const stmt of splitStatements(setupSql)) {
        if (!stmt.trim()) continue
        if (shouldSkipCreate(stmt, new Set())) continue
        try {
          runExec(input.companySlug, stmt, {
            source: `chat-panel-install:${input.frameId}`,
            note: `setup_sql for ${input.frameId}`,
            teamId: input.teamId,
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/already exists|duplicate column/i.test(msg)) throw e
        }
      }
    }

    panel.id = newPanelId()
    const cs = clampSpan(input.colSpan)
    const rs = clampSpan(input.rowSpan)
    if (cs != null) panel.colSpan = cs
    if (rs != null) panel.rowSpan = rs

    const layout = loadDashboard(input.companySlug, input.teamSlug) ?? { blocks: [] }
    const blocks = Array.isArray(layout.blocks)
      ? (layout.blocks as Record<string, unknown>[])
      : []
    blocks.push(panel)
    saveDashboard(input.companySlug, input.teamSlug, { ...layout, blocks })

    return { ok: true, panel, decision: 'standalone' }
  } finally {
    release()
  }
}

export interface RebindInput extends CommonCtx {
  panelId: string
  userIntent: string
}

export interface RebindResult {
  ok: true
  panel: Record<string, unknown>
}

/**
 * Re-run the AI binder for one panel and persist the new binding. Throws if
 * the panel id isn't in the dashboard. Schema introspection failures fall
 * back to an empty schema so the binder still gets a chance.
 */
export async function rebindPanelInLayout(input: RebindInput): Promise<RebindResult> {
  const release = await acquireInstallLock(input.teamId)
  try {
    const layout = loadDashboard(input.companySlug, input.teamSlug)
    if (!layout) throw new Error('dashboard not found')
    const blocks = Array.isArray(layout.blocks)
      ? (layout.blocks as Record<string, unknown>[])
      : []
    const idx = blocks.findIndex((b) => b?.id === input.panelId)
    if (idx < 0) throw new Error(`panel ${input.panelId} not found`)
    const panel = blocks[idx]!

    const schema = (() => {
      try {
        return describeSchema(input.companySlug, { teamId: input.teamId })
      } catch {
        return { tables: [], recent_migrations: [] }
      }
    })()

    const aiResult = await aiBindPanel({
      panel,
      description: typeof panel.description === 'string' ? panel.description : undefined,
      schema,
      userIntent: input.userIntent,
    })

    panel.binding = aiResult.binding as unknown as Record<string, unknown>
    blocks[idx] = panel
    saveDashboard(input.companySlug, input.teamSlug, { ...layout, blocks })

    return { ok: true, panel }
  } finally {
    release()
  }
}

export interface DeletePanelInput extends CommonCtx {
  panelId: string
}

export function deletePanelFromLayout(input: DeletePanelInput): { ok: true } {
  const layout = loadDashboard(input.companySlug, input.teamSlug)
  if (!layout) return { ok: true } // no dashboard → nothing to remove
  const blocks = Array.isArray(layout.blocks)
    ? (layout.blocks as Record<string, unknown>[])
    : []
  const filtered = blocks.filter((b) => b?.id !== input.panelId)
  saveDashboard(input.companySlug, input.teamSlug, { ...layout, blocks: filtered })
  try {
    deleteCache(input.panelId)
  } catch {
    /* cache miss is fine */
  }
  return { ok: true }
}

export interface PatchPanelInput extends CommonCtx {
  panelId: string
  patch: {
    col?: number
    row?: number
    colSpan?: number
    rowSpan?: number
    props?: Record<string, unknown>
    title?: string
    subtitle?: string
  }
}

export interface PatchPanelResult {
  ok: true
  panel: Record<string, unknown>
}

/**
 * Apply a partial update to one panel by id and persist. props are merged
 * (shallow); col/row/spans are replaced; title/subtitle are replaced.
 */
export function patchPanelInLayout(input: PatchPanelInput): PatchPanelResult {
  const layout = loadDashboard(input.companySlug, input.teamSlug)
  if (!layout) throw new Error('dashboard not found')
  const blocks = Array.isArray(layout.blocks)
    ? (layout.blocks as Record<string, unknown>[])
    : []
  const idx = blocks.findIndex((b) => b?.id === input.panelId)
  if (idx < 0) throw new Error(`panel ${input.panelId} not found`)
  const panel = blocks[idx]!

  const p = input.patch
  if (typeof p.col === 'number' && Number.isFinite(p.col)) panel.col = p.col
  if (typeof p.row === 'number' && Number.isFinite(p.row)) panel.row = p.row
  const cs = clampSpan(p.colSpan)
  const rs = clampSpan(p.rowSpan)
  if (cs != null) panel.colSpan = cs
  if (rs != null) panel.rowSpan = rs
  if (typeof p.title === 'string') panel.title = p.title
  if (typeof p.subtitle === 'string') panel.subtitle = p.subtitle
  if (p.props && typeof p.props === 'object') {
    const existing =
      panel.props && typeof panel.props === 'object' && !Array.isArray(panel.props)
        ? (panel.props as Record<string, unknown>)
        : {}
    panel.props = { ...existing, ...p.props }
  }

  blocks[idx] = panel
  saveDashboard(input.companySlug, input.teamSlug, { ...layout, blocks })
  return { ok: true, panel }
}
