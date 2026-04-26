export type PanelType =
  | 'kpi'
  | 'table'
  | 'kanban'
  | 'chart'
  | 'activity'
  | 'note'
  | 'list'
  | 'timeline'
  | 'markdown'
  | 'metric_grid'
  | 'calendar'

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
  /** Credential vault reference. Resolved server-side at fetch time to inject
   *  `Authorization` / custom headers. Never sent back to the client in
   *  responses. Used by `http` sources and (optionally) MCP servers that gate
   *  on named credentials. */
  auth_ref?: string
}

/** Inputs for an action form — typed palette kept small on purpose so that
 *  AI-generated forms stay predictable and the renderer is one file. */
export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'datetime-local'
  | 'time'
  | 'select'
  | 'toggle'

export interface FormField {
  name: string
  label: string
  type: FormFieldType
  required?: boolean
  placeholder?: string
  default?: unknown
  /** `select` only. */
  options?: string[]
  /** `number` only. */
  min?: number
  max?: number
}

export interface FormSchema {
  fields: FormField[]
}

/** Where an action lives on the panel UI. */
export type ActionPlacement = 'toolbar' | 'row' | 'inline' | 'drag'

/** What an action does when executed. Matches the source kinds except `static`
 *  and adds `file` for note-style writes. */
export type ActionTargetKind = 'team_data' | 'mcp' | 'http_recipe' | 'http_raw' | 'file'

export interface ActionTarget {
  kind: ActionTargetKind
  /** Kind-specific fields:
   *   - team_data: { sql: string } — parameterized with :name bindings
   *   - mcp:       { server, tool, args_template }
   *   - http_*:    { url, method, headers?, body_template? }
   *   - file:      { path, format?: 'markdown' | 'text' }
   */
  config: Record<string, unknown>
  auth_ref?: string
}

export interface PanelAction {
  id: string
  kind: 'create' | 'update' | 'delete' | 'custom'
  label: string
  placement: ActionPlacement
  form?: FormSchema
  /** Fields on the target that this action mutates. Used by inline/drag to
   *  know which properties can be changed. */
  fields?: string[]
  target: ActionTarget
  /** Show a confirm modal before executing. Delete/destructive: always true. */
  confirm?: boolean
  /** External writes that cannot be undone (send_email, create_invoice, …).
   *  Forces a two-step confirm and a prominent warning. */
  irreversible?: boolean
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
  /** Timeline: dotted path in each row for the event timestamp. Accepts number
   *  (unix ms / s) or ISO string. */
  ts?: string
  /** Timeline: dotted path in each row for the event kind/category. Used for
   *  a subtle chip color in the renderer. */
  kind?: string
  /** Markdown: either a dotted path into raw (picks the first row's field) or
   *  a literal string. If omitted, the raw source is stringified. */
  text?: string
  /** Metric grid: each cell is its own KPI computed over the (filtered) rows. */
  cells?: MetricGridCellSpec[]
}

export interface MetricGridCellSpec {
  label: string
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'
  field?: string
  /** Per-cell row filter expression (same grammar as PanelMap.filter). */
  filter?: string
  hint?: string
  /** Optional dotted path into raw for a delta indicator ("+12%" etc). */
  delta_field?: string
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
  /** Write operations available on this panel. Rendered as toolbar buttons,
   *  row hover icons, inline editors, or kanban drag handlers per `placement`. */
  actions?: PanelAction[]
}

export interface PanelSpec {
  id: string
  type: PanelType
  title: string
  subtitle?: string
  colSpan?: 1 | 2 | 3 | 4 | 5 | 6
  rowSpan?: 1 | 2 | 3 | 4 | 5 | 6
  /** Explicit grid placement (1-based). When unset, the panel falls into the
   *  CSS grid auto-flow (top-left packing). Set after the user drags it. */
  col?: number
  row?: number
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

export interface DashboardBackup {
  name: string
  saved_at: number
}

export async function fetchDashboardBackups(teamId: string): Promise<DashboardBackup[]> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/dashboard/backups`)
  if (!res.ok) throw new Error(`GET backups ${res.status}`)
  const data = (await res.json()) as { backups: DashboardBackup[] }
  return data.backups
}

export async function restoreDashboardBackup(teamId: string, name: string): Promise<void> {
  const res = await fetch(`/api/teams/${encodeURIComponent(teamId)}/dashboard/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`POST restore ${res.status}`)
}
