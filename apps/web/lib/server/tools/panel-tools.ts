/**
 * Chat-callable LLM tools for the in-app dashboard panel system. Each tool
 * is a thin wrapper around server-side primitives in `lib/server/panels/*`
 * and `lib/server/dashboards.ts` — no HTTP roundtrips.
 *
 * Categories:
 *   - `panel_*`  → category: 'panel'   (per-panel ops)
 *   - `dashboard_*` → category: 'dashboard'  (whole-dashboard ops)
 *
 * The system prompt's `# Built-in tools` section enumerates these so the
 * LLM maps user intents like "패널 추가해줘" / "대시보드 백업 복원" onto
 * the right tool instead of falling back to Excel/Postgres priors.
 */

import {
  loadDashboard,
  listDashboardBackups,
  restoreDashboardBackup,
} from '../dashboards'
import { fetchMarketIndex } from '../market'
import { executeAction, type PanelActionSpec } from '../panels/actions'
import * as cache from '../panels/cache'
import {
  deletePanelFromLayout,
  installPanelStandalone,
  patchPanelInLayout,
  rebindPanelInLayout,
} from '../panels/installer'
import { refreshOneNow } from '../panels/refresher'
import type { Tool } from './base'

// ---- shared helpers ---------------------------------------------------------

interface DenyEnvelope {
  ok: false
  error_code: string
  message: string
  suggestion: string
}

function deny(error_code: string, message: string, suggestion: string): DenyEnvelope {
  return { ok: false, error_code, message, suggestion }
}

function findPanel(
  companySlug: string,
  teamSlug: string,
  panelId: string,
): Record<string, unknown> | null {
  const layout = loadDashboard(companySlug, teamSlug)
  if (!layout) return null
  const blocks = Array.isArray(layout.blocks)
    ? (layout.blocks as Record<string, unknown>[])
    : []
  return blocks.find((b) => b?.id === panelId) ?? null
}

function summarisePanel(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id ?? null,
    type: p.type ?? null,
    title: p.title ?? null,
    subtitle: p.subtitle ?? null,
    has_binding: !!p.binding,
    col_span: p.colSpan ?? null,
    row_span: p.rowSpan ?? null,
    col: p.col ?? null,
    row: p.row ?? null,
  }
}

// ---- tool factory -----------------------------------------------------------

export function panelTools(
  companySlug: string,
  teamSlug: string,
  teamId: string,
): Tool[] {
  const tools: Tool[] = []

  tools.push({
    name: 'panel_list',
    description:
      "List every panel currently on this team's dashboard. Returns id, type, " +
      'title, has_binding, col_span/row_span, and grid position. Call before ' +
      'panel_get/panel_update_binding/panel_delete so you have real ids.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const layout = loadDashboard(companySlug, teamSlug)
      const blocks = Array.isArray(layout?.blocks)
        ? (layout!.blocks as Record<string, unknown>[])
        : []
      return JSON.stringify({ ok: true, panels: blocks.map(summarisePanel) })
    },
    hint: 'Listing panels…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_get',
    description:
      'Fetch one panel by id with its full spec (binding, props, position). ' +
      'Use after panel_list to inspect a specific panel before editing.',
    parameters: {
      type: 'object',
      properties: { panel_id: { type: 'string' } },
      required: ['panel_id'],
    },
    handler: async (args) => {
      const panel = findPanel(companySlug, teamSlug, String(args.panel_id ?? ''))
      if (!panel) {
        return JSON.stringify(
          deny(
            'panel_not_found',
            `panel ${args.panel_id} not on this dashboard`,
            'Call panel_list first to see real panel ids.',
          ),
        )
      }
      return JSON.stringify({ ok: true, panel })
    },
    hint: 'Reading panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_market_list',
    description:
      'List installable panel frames from the market (kpi, table, kanban, ' +
      'chart variants, calendar, memo, …). Use BEFORE panel_install so the ' +
      'frame_id you pick actually exists.',
    parameters: {
      type: 'object',
      properties: { category: { type: 'string', description: 'Optional category filter, e.g. "kpi", "chart".' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const idx = await fetchMarketIndex()
      const all = idx.panels ?? []
      const cat = typeof args.category === 'string' ? args.category : null
      const filtered = cat
        ? all.filter((p) => (p.category ?? '').toLowerCase() === cat.toLowerCase())
        : all
      return JSON.stringify({ ok: true, panels: filtered, warnings: idx.warnings })
    },
    hint: 'Listing panel frames…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_install',
    description:
      "Install a panel frame onto this team's dashboard. Registers the panel " +
      "with the frame's manifest binding (no AI bind) and runs its setup_sql " +
      'idempotently. After install, you MUST call `panel_update_binding(panel_id, ' +
      'user_intent)` to make the panel actually show data tailored to what the ' +
      'user wants — the manifest binding is a placeholder.',
    parameters: {
      type: 'object',
      properties: {
        frame_id: { type: 'string', description: 'From panel_market_list[].id' },
        category: { type: 'string', description: 'From panel_market_list[].category' },
        col_span: { type: 'integer', minimum: 1, maximum: 6 },
        row_span: { type: 'integer', minimum: 1, maximum: 6 },
      },
      required: ['frame_id', 'category'],
    },
    handler: async (args) => {
      const frameId = String(args.frame_id ?? '')
      const category = String(args.category ?? '')
      if (!frameId || !category) {
        return JSON.stringify(
          deny('invalid_args', 'frame_id and category are required', 'Get them from panel_market_list.'),
        )
      }
      try {
        const res = await installPanelStandalone({
          frameId,
          category,
          companySlug,
          teamSlug,
          teamId,
          colSpan: typeof args.col_span === 'number' ? args.col_span : undefined,
          rowSpan: typeof args.row_span === 'number' ? args.row_span : undefined,
        })
        return JSON.stringify({
          ok: true,
          panel: summarisePanel(res.panel),
          decision: res.decision,
          next: 'Call panel_update_binding({panel_id, user_intent}) to bind data.',
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('install_failed', msg, 'Check frame_id/category and team schema.'))
      }
    },
    hint: 'Installing panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_update_binding',
    description:
      "Re-run the AI binder for one panel against the team's current schema, " +
      'using the supplied user intent (e.g. "show monthly revenue"). Persists ' +
      'the new binding into dashboard.yaml. Use after panel_install or when the ' +
      'user wants different data on an existing panel. May take 5–30s.',
    parameters: {
      type: 'object',
      properties: {
        panel_id: { type: 'string' },
        user_intent: { type: 'string', description: 'Plain-language description of what the panel should show.' },
      },
      required: ['panel_id', 'user_intent'],
    },
    handler: async (args) => {
      const panelId = String(args.panel_id ?? '')
      const userIntent = String(args.user_intent ?? '')
      if (!panelId || !userIntent.trim()) {
        return JSON.stringify(
          deny('invalid_args', 'panel_id and user_intent are required', 'Provide both.'),
        )
      }
      try {
        const res = await rebindPanelInLayout({
          companySlug,
          teamSlug,
          teamId,
          panelId,
          userIntent: userIntent.trim(),
        })
        return JSON.stringify({ ok: true, panel: summarisePanel(res.panel) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('rebind_failed', msg, 'Verify panel_id with panel_list.'))
      }
    },
    hint: 'AI-binding panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_set_position',
    description:
      "Move or resize one panel on the grid. col/row are 1-based; col_span/" +
      'row_span clamp to [1,6]. Omitted fields are left unchanged.',
    parameters: {
      type: 'object',
      properties: {
        panel_id: { type: 'string' },
        col: { type: 'integer', minimum: 1 },
        row: { type: 'integer', minimum: 1 },
        col_span: { type: 'integer', minimum: 1, maximum: 6 },
        row_span: { type: 'integer', minimum: 1, maximum: 6 },
      },
      required: ['panel_id'],
    },
    handler: async (args) => {
      try {
        const res = patchPanelInLayout({
          companySlug,
          teamSlug,
          teamId,
          panelId: String(args.panel_id ?? ''),
          patch: {
            col: typeof args.col === 'number' ? args.col : undefined,
            row: typeof args.row === 'number' ? args.row : undefined,
            colSpan: typeof args.col_span === 'number' ? args.col_span : undefined,
            rowSpan: typeof args.row_span === 'number' ? args.row_span : undefined,
          },
        })
        return JSON.stringify({ ok: true, panel: summarisePanel(res.panel) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('patch_failed', msg, 'Check panel_id.'))
      }
    },
    hint: 'Moving panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_set_props',
    description:
      "Shallow-merge a JSON patch into one panel's `props` (rendering hints " +
      "like format/currency/time_ranges). Pass title/subtitle in the same call " +
      'to rename the panel.',
    parameters: {
      type: 'object',
      properties: {
        panel_id: { type: 'string' },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        props_patch: { type: 'object', additionalProperties: true },
      },
      required: ['panel_id'],
    },
    handler: async (args) => {
      try {
        const res = patchPanelInLayout({
          companySlug,
          teamSlug,
          teamId,
          panelId: String(args.panel_id ?? ''),
          patch: {
            title: typeof args.title === 'string' ? args.title : undefined,
            subtitle: typeof args.subtitle === 'string' ? args.subtitle : undefined,
            props:
              args.props_patch && typeof args.props_patch === 'object' && !Array.isArray(args.props_patch)
                ? (args.props_patch as Record<string, unknown>)
                : undefined,
          },
        })
        return JSON.stringify({ ok: true, panel: summarisePanel(res.panel) })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('patch_failed', msg, 'Check panel_id.'))
      }
    },
    hint: 'Updating panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_delete',
    description:
      "Remove a panel from the dashboard. SOFT delete — the underlying data " +
      'table is preserved (other panels may reference it). Requires ' +
      '`confirm: true`. Caches are dropped automatically.',
    parameters: {
      type: 'object',
      properties: {
        panel_id: { type: 'string' },
        confirm: {
          type: 'boolean',
          description: 'Required to be true. Confirms the user agreed to remove this panel.',
        },
      },
      required: ['panel_id', 'confirm'],
    },
    handler: async (args) => {
      if (args.confirm !== true) {
        return JSON.stringify(
          deny(
            'destructive_unconfirmed',
            'panel_delete requires confirm: true',
            'Tell the user which panel will be removed (use panel_get to show its title), get their OK, then re-invoke with confirm: true.',
          ),
        )
      }
      try {
        deletePanelFromLayout({
          companySlug,
          teamSlug,
          teamId,
          panelId: String(args.panel_id ?? ''),
        })
        return JSON.stringify({ ok: true })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('delete_failed', msg, 'Check panel_id with panel_list.'))
      }
    },
    hint: 'Deleting panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_refresh',
    description:
      'Force an immediate refresh of one panel (re-runs its source binding) ' +
      'and returns the resulting cache row. Use after edits or when the user ' +
      'asks for fresh data.',
    parameters: {
      type: 'object',
      properties: { panel_id: { type: 'string' } },
      required: ['panel_id'],
    },
    handler: async (args) => {
      try {
        const row = await refreshOneNow(String(args.panel_id ?? ''))
        return JSON.stringify({ ok: true, cache: row })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('refresh_failed', msg, 'Verify panel exists with panel_list.'))
      }
    },
    hint: 'Refreshing panel…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_get_data',
    description:
      "Read the panel's last cached result without forcing a refresh. " +
      'Returns null when nothing has been fetched yet.',
    parameters: {
      type: 'object',
      properties: { panel_id: { type: 'string' } },
      required: ['panel_id'],
    },
    handler: async (args) => {
      const row = cache.get(String(args.panel_id ?? ''))
      return JSON.stringify({ ok: true, cache: row })
    },
    hint: 'Reading cache…',
    category: 'panel',
  })

  tools.push({
    name: 'panel_execute_action',
    description:
      "Run a panel-defined action (toolbar button, row action). Pass the " +
      'action_id and a `values` object matching the action\'s form fields. ' +
      "List a panel's actions via panel_get → binding.actions[].",
    parameters: {
      type: 'object',
      properties: {
        panel_id: { type: 'string' },
        action_id: { type: 'string' },
        values: { type: 'object', additionalProperties: true },
      },
      required: ['panel_id', 'action_id'],
    },
    handler: async (args) => {
      const panelId = String(args.panel_id ?? '')
      const actionId = String(args.action_id ?? '')
      const values =
        args.values && typeof args.values === 'object' && !Array.isArray(args.values)
          ? (args.values as Record<string, unknown>)
          : {}
      const panel = findPanel(companySlug, teamSlug, panelId)
      if (!panel) {
        return JSON.stringify(
          deny('panel_not_found', `panel ${panelId} not found`, 'Use panel_list to find ids.'),
        )
      }
      const binding = (panel.binding ?? {}) as Record<string, unknown>
      const actions = Array.isArray(binding.actions) ? (binding.actions as PanelActionSpec[]) : []
      const action = actions.find((a) => a?.id === actionId)
      if (!action) {
        return JSON.stringify(
          deny(
            'action_not_found',
            `action ${actionId} not on panel ${panelId}`,
            'Inspect panel.binding.actions via panel_get.',
          ),
        )
      }
      try {
        const res = await executeAction({ companySlug, teamSlug, teamId }, panelId, action, values)
        return JSON.stringify({ ok: true, result: res.result, rows_changed: res.rows_changed })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return JSON.stringify(deny('action_failed', msg, 'Check action_id and values.'))
      }
    },
    hint: 'Running action…',
    category: 'panel',
  })

  tools.push({
    name: 'dashboard_list_backups',
    description:
      'List timestamped auto-backups of this dashboard. Newest first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const backups = listDashboardBackups(companySlug, teamSlug)
      return JSON.stringify({ ok: true, backups })
    },
    hint: 'Listing backups…',
    category: 'dashboard',
  })

  tools.push({
    name: 'dashboard_restore_backup',
    description:
      'Restore the dashboard from a timestamped backup. Requires `confirm: ' +
      'true`. The current layout is itself backed up before the restore so ' +
      'the user can roll forward again.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Backup name from dashboard_list_backups.' },
        confirm: { type: 'boolean' },
      },
      required: ['name', 'confirm'],
    },
    handler: async (args) => {
      if (args.confirm !== true) {
        return JSON.stringify(
          deny(
            'destructive_unconfirmed',
            'dashboard_restore_backup requires confirm: true',
            'Tell the user which timestamp will replace their current layout, get OK, retry with confirm: true.',
          ),
        )
      }
      const name = String(args.name ?? '')
      const ok = restoreDashboardBackup(companySlug, teamSlug, name)
      if (!ok) {
        return JSON.stringify(
          deny('backup_not_found', `backup ${name} not found`, 'List backups via dashboard_list_backups.'),
        )
      }
      return JSON.stringify({ ok: true })
    },
    hint: 'Restoring dashboard…',
    category: 'dashboard',
  })

  return tools
}
