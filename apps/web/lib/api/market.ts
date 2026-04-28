/** Client bindings for the Frame Market (cloud catalog of shareable
 *  company / team / agent frames). Server fetches from GitHub; the UI just
 *  talks to our /api/market endpoints. */

export type MarketType = 'company' | 'team' | 'agent' | 'panel'

export interface MarketEntry {
  id: string
  type: MarketType
  name: string
  description: string
  tags: string[]
  author?: string
  agent_count?: number
  teams?: string[]
  category?: string
  sizes?: PanelSize[]
  /** DDL the panel would run in blank form. Surfaced so the client can
   *  preview what connecting vs keeping separate would do. */
  setup_sql?: string
  /** Static thumbnail spec for the Frame Market modal. Renderer-agnostic —
   *  just describes what shape to draw with what dummy values. Lets new
   *  panels ship with a preview without any app code change. */
  preview?: PanelPreview
}

export interface PanelSize {
  colSpan: 1 | 2 | 3 | 4
  rowSpan: 1 | 2 | 3 | 4
}

export type PanelPreview =
  | {
      kind: 'line'
      data: number[]
      subtitle?: string
      /** When set, LineChartPreview shows a right-aligned tab strip and tails
       *  the data array to the chosen N. Mirrors the live panel UX. */
      time_ranges?: number[]
      default_range?: number
    }
  | { kind: 'area'; data: number[]; subtitle?: string }
  | { kind: 'bar'; bars: { label: string; value: number }[]; subtitle?: string; format?: 'currency'; orientation?: 'vertical' | 'horizontal' }
  | { kind: 'pie'; slices: { label: string; value: number }[]; subtitle?: string }
  | {
      kind: 'kpi'
      value: string
      hint: string
      tone?: 'positive' | 'negative'
      subtitle?: string
      /** Inline delta caption shown under the big number — "▲ 18.0% vs 지난 주". */
      delta?: string
      /** "12 / 50" target ratio + visible bar at `progress` percent (0..100). */
      target?: string
      progress?: number
    }
  | { kind: 'kanban'; columns: { label: string; cards: string[] }[]; subtitle?: string }
  | { kind: 'table'; columns: string[]; rows: string[][]; subtitle?: string }
  | { kind: 'heatmap'; rowLabels: string[]; colLabels: string[]; values: number[][]; subtitle?: string }
  | { kind: 'stat_row'; stats: { label: string; value: string }[]; subtitle?: string }
  | { kind: 'calendar'; month: string; days: { day: number; events?: number; today?: boolean; muted?: boolean }[]; subtitle?: string }
  | { kind: 'memo'; text: string; subtitle?: string }
  | {
      kind: 'session_status'
      stats: { label: string; value: string }[]
      subtitle?: string
    }

export interface MarketIndex {
  companies: MarketEntry[]
  teams: MarketEntry[]
  agents: MarketEntry[]
  panels: MarketEntry[]
  warnings: string[]
  source: string
}

export async function fetchMarketIndex(): Promise<MarketIndex> {
  const res = await fetch('/api/market')
  if (!res.ok) throw new Error(`GET /api/market ${res.status}`)
  return (await res.json()) as MarketIndex
}

export interface InstallMarketResult {
  type: MarketType
  id: string
  team?: Record<string, unknown>
  agent?: Record<string, unknown>
  panel?: Record<string, unknown>
  warnings?: string[]
}

export async function installMarketEntry(input: {
  type: MarketType
  id: string
  target_company_slug?: string
  target_team_slug?: string
  /** Required for `type=panel` — panel frames are stored under category subdirs. */
  category?: string
}): Promise<InstallMarketResult> {
  const res = await fetch('/api/market/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`install failed (${res.status}): ${body}`)
  }
  return (await res.json()) as InstallMarketResult
}

// ─── Panel two-phase install ──────────────────────────────────────────

export type InstallDecision = 'reuse' | 'extend' | 'standalone'

export interface InstallPlan {
  decision: InstallDecision
  brief: string
  target_table: string | null
  alter_sql: string[]
  skip_create_tables: string[]
  rewrite_panel_sql: string | null
  confidence: number
  ai_called: boolean
}

export interface PanelInstallPreview {
  plan: InstallPlan
  panel_title: string | null
  setup_sql: string | null
  panel_sql: string | null
}

export async function previewPanelInstall(input: {
  id: string
  category: string
  target_company_slug: string
  target_team_slug: string
  target_team_id: string
  user_intent?: string | null
}): Promise<PanelInstallPreview> {
  const res = await fetch('/api/market/install/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`preview failed (${res.status}): ${body}`)
  }
  return (await res.json()) as PanelInstallPreview
}

export async function applyPanelInstall(input: {
  id: string
  category: string
  target_company_slug: string
  target_team_slug: string
  target_team_id: string
  decision: InstallDecision
  alter_sql: string[]
  skip_create_tables: string[]
  user_intent?: string | null
  prebuilt_binding?: Record<string, unknown> | null
  prebuilt_setup_sql?: string | null
  col_span?: number
  row_span?: number
}): Promise<{ ok: true; panel: Record<string, unknown>; decision: InstallDecision }> {
  const res = await fetch('/api/market/install/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`apply failed (${res.status}): ${body}`)
  }
  return (await res.json()) as {
    ok: true
    panel: Record<string, unknown>
    decision: InstallDecision
  }
}

export interface AiBindPreview {
  binding: Record<string, unknown>
  panel_type: string
  /** Frame manifest's `panel.props` — needed by the renderer for chart
   *  variant, formatters, etc. Without these the preview falls back to
   *  default rendering (e.g. bars instead of a line chart). */
  panel_props: Record<string, unknown> | null
  data: unknown
  /** Non-null when the binding was generated but could not be executed
   *  (e.g. AI invented a column that doesn't exist). The modal still
   *  shows the binding so the user can decide whether to install. */
  error: string | null
  /** AI-generated CREATE TABLE that accompanied the binding (only set when
   *  the binder asked for a new table). Round-tripped to install so the
   *  prebuilt-binding shortcut still creates the new table. */
  setup_sql: string | null
}

export async function aiBindPreview(input: {
  id: string
  category: string
  target_company_slug: string
  target_team_slug: string
  target_team_id: string
  user_intent: string | null
}): Promise<AiBindPreview> {
  const res = await fetch('/api/market/install/ai-bind-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ai-bind-preview failed (${res.status}): ${body}`)
  }
  return (await res.json()) as AiBindPreview
}
