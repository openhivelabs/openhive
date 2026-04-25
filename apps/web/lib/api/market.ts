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
}

export interface PanelSize {
  colSpan: 1 | 2 | 3 | 4
  rowSpan: 1 | 2 | 3 | 4
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
