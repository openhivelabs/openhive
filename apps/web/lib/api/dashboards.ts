export type PanelType = 'kpi' | 'table' | 'kanban' | 'chart' | 'activity' | 'note' | 'list'

/** Where a block's data comes from. The shape inside `config` varies by kind:
 *   - mcp:        { server, tool, args }
 *   - team_data:  { sql }                       (read-only SELECT)
 *   - http:       { url, method?, headers?, body? }
 *   - file:       { path }                      (relative to team data dir)
 *   - static:     { value }                     (literal data, useful for AI builder previews)
 */
export type SourceKind = 'mcp' | 'team_data' | 'http' | 'file' | 'static'

export interface PanelSource {
  kind: SourceKind
  config: Record<string, unknown>
}

/** Declarative mapping from raw source response → the shape the block needs.
 *  `rows` is a JSONPath into the response (e.g. "$.deals[*]"); the other fields
 *  are dotted paths into each row. The mapper interprets these — no AI-generated
 *  code execution.
 */
export interface PanelMap {
  rows?: string
  group_by?: string
  title?: string
  value?: string
  columns?: string[]
  filter?: string  // simple expression: "amount > 10000"
  /** For kpi/single-value blocks: aggregate over rows. */
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'
  /** Override which row field the aggregate consumes. Defaults to `value`. */
  aggregate_field?: string
  /** Cell click action: what happens when the user clicks a row/card/list item.
   *  Applies to table rows, kanban cards, list items. No effect on kpi/chart. */
  on_click?: CellAction
}

/** A Cell is an interactive unit inside a Panel (a table row, kanban card, list
 *  item). `on_click` describes what happens when the user clicks it.
 *    - detail:    open a modal showing the row's raw fields as key/value pairs
 *    - open_url:  open the URL at `url_field` (dotted path in the row) in a new tab
 */
export type CellAction =
  | { kind: 'detail' }
  | { kind: 'open_url'; url_field: string }

export interface PanelBinding {
  source: PanelSource
  map: PanelMap
  /** Server polls source at this cadence. 0 = manual refresh only. */
  refresh_seconds: number
}

export interface PanelSpec {
  id: string
  type: PanelType
  title: string
  subtitle?: string
  colSpan?: 1 | 2 | 3 | 4
  rowSpan?: 1 | 2 | 3 | 4
  props?: Record<string, unknown>
  /** Optional. When present, the block renders cached data refreshed by the
   *  server on a schedule. When absent, the block falls back to its existing
   *  page-level data (legacy behavior). */
  binding?: PanelBinding
}

export interface DashboardLayout {
  blocks: PanelSpec[]
}

export async function fetchDashboard(teamId: string): Promise<DashboardLayout | null> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/dashboard`)
  if (!res.ok) throw new Error(`GET dashboard ${res.status}`)
  const data = (await res.json()) as { layout: DashboardLayout | null }
  return data.layout
}

export async function saveDashboard(teamId: string, layout: DashboardLayout): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/dashboard`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout }),
  })
  if (!res.ok) throw new Error(`PUT dashboard ${res.status}`)
}
