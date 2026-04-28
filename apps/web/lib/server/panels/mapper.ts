/**
 * Declarative mapper — turn raw source data into block-shape data.
 * Ports apps/server/openhive/panels/mapper.py.
 *
 * Dependency-free at runtime: jsonpath-plus for row extraction, a tiny
 * in-line expression evaluator for filters. No JS sandbox, no AI-generated
 * code — declarative selectors only.
 */

import { JSONPath } from 'jsonpath-plus'

interface MapSpec {
  rows?: string
  group_by?: string
  /** Second grouping axis. When set on a chart binding, the mapper builds
   *  a multi-series matrix (group_by → x, series_by → series) — used by
   *  stacked bar/area and heatmap. */
  series_by?: string
  title?: string
  value?: string
  columns?: string[]
  filter?: string
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'
  aggregate_field?: string
  /** KPI only — pick a prior-period value out of the same first row so the
   *  renderer can derive a percent delta. Works in tandem with SQL that
   *  computes both current and prior in one row. */
  delta_field?: string
  /** KPI only — pick a target / goal value out of the first row so the
   *  renderer can draw a progress bar. */
  target_field?: string
  ts?: string
  /** Calendar only — end timestamp column. When set, calendar event cards
   *  span from `ts` to `ts_end`; missing means a default 1-hour duration. */
  ts_end?: string
  kind?: string
  text?: string
  cells?: MetricCellSpec[]
}

interface MetricCellSpec {
  label: string
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'
  field?: string
  filter?: string
  hint?: string
  delta_field?: string
}

const FILTER_RE =
  /^\s*(?<field>[\w.]+)\s*(?<op>==|!=|<=|>=|<|>|is\s+not\s+null|is\s+null)\s*(?<rhs>.*)\s*$/

type Predicate = (row: unknown) => boolean

const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => (typeof a === 'number' && typeof b === 'number' ? a < b : false),
  '<=': (a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a <= b : false,
  '>': (a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a > b : false,
  '>=': (a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a >= b : false,
}

// -------- public API --------

export function apply(
  raw: unknown,
  map: MapSpec | null | undefined,
  panelType: string,
): Record<string, unknown> {
  const spec = map && typeof map === 'object' ? map : ({} as MapSpec)
  let rows = extractRows(raw, spec.rows)
  rows = filterRows(rows, spec.filter)

  if (panelType === 'kpi') return shapeKpi(rows, spec)
  if (panelType === 'table') return shapeTable(rows, spec)
  if (panelType === 'kanban') return shapeKanban(rows, spec)
  if (panelType === 'chart') return shapeChart(rows, spec)
  if (panelType === 'list') return shapeList(rows, spec)
  if (panelType === 'timeline') return shapeTimeline(rows, spec)
  if (panelType === 'markdown') return shapeMarkdown(raw, rows, spec)
  if (panelType === 'metric_grid') return shapeMetricGrid(rows, spec)
  if (panelType === 'stat_row') return shapeMetricGrid(rows, spec)
  if (panelType === 'calendar') return shapeCalendar(rows, spec)
  return { rows }
}

// -------- row extraction --------

function extractRows(raw: unknown, rowsPath?: string): unknown[] {
  if (rowsPath) {
    try {
      const matches = JSONPath({
        path: rowsPath,
        json: raw as object,
      }) as unknown[]
      return matches
    } catch {
      return []
    }
  }
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.rows)) return r.rows as unknown[]
    for (const key of ['results', 'items', 'data', 'records']) {
      const v = r[key]
      if (Array.isArray(v)) return v as unknown[]
    }
  }
  return []
}

function filterRows(rows: unknown[], filterExpr?: string): unknown[] {
  if (!filterExpr || typeof filterExpr !== 'string') return rows
  const pred = compileFilter(filterExpr)
  if (!pred) return rows
  return rows.filter(pred)
}

function compileFilter(expr: string): Predicate | null {
  const m = FILTER_RE.exec(expr)
  if (!m || !m.groups) return null
  const { field, op } = m.groups
  const rhsRaw = (m.groups.rhs ?? '').trim()

  if (op && op.startsWith('is')) {
    const wantNull = op === 'is null'
    return (row) => (getPath(row, field ?? '') === null) === wantNull
  }

  const rhs = coerceLiteral(rhsRaw)
  const cmp = op ? OPS[op] : undefined
  if (!cmp) return null

  return (row) => {
    try {
      return cmp(getPath(row, field ?? ''), rhs)
    } catch {
      return false
    }
  }
}

function coerceLiteral(s: string): unknown {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  const lower = t.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null') return null
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10)
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number.parseFloat(t)
  return t
}

function getPath(row: unknown, path: string): unknown {
  if (!row || typeof row !== 'object' || !path) return null
  let cur: unknown = row
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null
    cur = (cur as Record<string, unknown>)[part]
    if (cur === undefined || cur === null) return null
  }
  return cur
}

// -------- per-block shapers --------

function shapeKpi(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const agg = (spec.aggregate ?? 'count').toLowerCase()
  const field = spec.aggregate_field ?? spec.value
  const values: number[] = []
  if (field) {
    for (const r of rows) {
      const v =
        r && typeof r === 'object' ? getPath(r, field) : (r as unknown)
      const n = Number(v)
      if (Number.isFinite(n)) values.push(n)
    }
  }

  let result: unknown
  if (agg === 'count') result = rows.length
  else if (agg === 'sum')
    result = values.length > 0 ? values.reduce((a, b) => a + b, 0) : 0
  else if (agg === 'avg')
    result =
      values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0
  else if (agg === 'min') result = values.length > 0 ? Math.min(...values) : 0
  else if (agg === 'max') result = values.length > 0 ? Math.max(...values) : 0
  else if (agg === 'first')
    result = values[0] ?? (rows.length > 0 ? rows[0] : null)
  else result = rows.length
  const out: Record<string, unknown> = {
    value: result,
    rows_considered: rows.length,
  }
  // Pull prior / target out of the first row so the SQL can compute them
  // alongside the main value. Renderer interprets prior → delta, target →
  // progress bar. We always emit the keys when the field is configured —
  // even if the lookup fails this refresh — so the cached shape stays
  // stable across data variability and the schema-drift detector doesn't
  // false-positive on a transient NULL.
  const first = rows[0]
  if (spec.delta_field) {
    const p =
      first && typeof first === 'object'
        ? Number(getPath(first, spec.delta_field))
        : Number.NaN
    out.prior = Number.isFinite(p) ? p : null
  }
  if (spec.target_field) {
    const t =
      first && typeof first === 'object'
        ? Number(getPath(first, spec.target_field))
        : Number.NaN
    out.target = Number.isFinite(t) ? t : null
  }
  return out
}

function shapeTable(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  let columns = spec.columns
  if (!Array.isArray(columns)) {
    if (rows.length > 0 && rows[0] && typeof rows[0] === 'object') {
      columns = Object.keys(rows[0] as Record<string, unknown>)
    } else {
      columns = []
    }
  }
  const flat = rows.map((r) => {
    if (r && typeof r === 'object') {
      return Object.fromEntries(columns!.map((c) => [c, getPath(r, c)]))
    }
    return { value: r }
  })
  return { columns, rows: flat }
}

function shapeKanban(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const groupBy = spec.group_by
  const titleField = spec.title
  const valueField = spec.value
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const r of rows) {
    const key = groupBy ? getPath(r, groupBy) : '—'
    const keyStr = key === null || key === undefined ? '—' : String(key)
    const item = {
      title: titleField ? getPath(r, titleField) : null,
      value: valueField ? getPath(r, valueField) : null,
      raw: r,
    }
    if (!groups.has(keyStr)) groups.set(keyStr, [])
    groups.get(keyStr)!.push(item)
  }
  return {
    groups: [...groups.entries()].map(([k, v]) => ({
      key: k,
      label: k,
      items: v,
    })),
  }
}

function shapeChart(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const xField = spec.group_by
  const seriesField = spec.series_by
  const yField = spec.value
  if (!xField) return { series: [], x: [], y: [] }

  // Two-dimensional path: each row contributes to a (xKey, sKey) bucket.
  // Output exposes both flat-stacked (`series[]` indexed by xKey) and a
  // matrix (`rows`/`cols`/`values`) so the chart view can render either
  // a stacked bar/area or a heatmap from the same shape.
  if (seriesField) {
    const matrix = new Map<string, Map<string, number>>()
    const xKeys = new Set<string>()
    const sKeys = new Set<string>()
    for (const r of rows) {
      const x = getPath(r, xField)
      const s = getPath(r, seriesField)
      const xKey = x === null || x === undefined ? '—' : String(x)
      const sKey = s === null || s === undefined ? '—' : String(s)
      const v = yField ? Number(getPath(r, yField)) : 1
      const delta = Number.isFinite(v) ? v : 0
      xKeys.add(xKey)
      sKeys.add(sKey)
      let row = matrix.get(sKey)
      if (!row) {
        row = new Map<string, number>()
        matrix.set(sKey, row)
      }
      row.set(xKey, (row.get(xKey) ?? 0) + delta)
    }
    const x = [...xKeys]
    const seriesNames = [...sKeys]
    const series = seriesNames.map((name) => {
      const row = matrix.get(name)
      return {
        name,
        data: x.map((xKey) => row?.get(xKey) ?? 0),
      }
    })
    // Total per x — handy for tooltips and for back-compat with consumers
    // that still read a flat `y[]`.
    const y = x.map((xKey) =>
      series.reduce((sum, s) => sum + (s.data[x.indexOf(xKey)] ?? 0), 0),
    )
    return {
      x,
      y,
      series,
      matrix: {
        rows: seriesNames,
        cols: x,
        values: seriesNames.map((name) => {
          const row = matrix.get(name)
          return x.map((xKey) => row?.get(xKey) ?? 0)
        }),
      },
    }
  }

  const buckets = new Map<string, number>()
  for (const r of rows) {
    const x = getPath(r, xField)
    const xKey = x === null || x === undefined ? '—' : String(x)
    if (yField) {
      const y = Number(getPath(r, yField))
      const delta = Number.isFinite(y) ? y : 0
      buckets.set(xKey, (buckets.get(xKey) ?? 0) + delta)
    } else {
      buckets.set(xKey, (buckets.get(xKey) ?? 0) + 1)
    }
  }
  const x = [...buckets.keys()]
  const y = [...buckets.values()]
  return {
    x,
    y,
    series: [{ name: yField ?? 'count', data: y }],
  }
}

function shapeList(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const titleField = spec.title
  const valueField = spec.value
  return {
    items: rows.map((r) => ({
      title: titleField
        ? getPath(r, titleField)
        : r && typeof r === 'object'
          ? null
          : r,
      value: valueField ? getPath(r, valueField) : null,
      raw: r,
    })),
  }
}

function shapeTimeline(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const tsField = spec.ts ?? 'ts'
  const titleField = spec.title
  const kindField = spec.kind
  const events = rows.map((r) => ({
    ts: tsField ? getPath(r, tsField) : null,
    title:
      titleField && r && typeof r === 'object'
        ? getPath(r, titleField)
        : r && typeof r === 'object'
          ? null
          : r,
    kind: kindField && r && typeof r === 'object' ? getPath(r, kindField) : null,
    raw: r,
  }))
  return { events }
}

/** Calendar panel — interactive month grid + detail pane. Input is a list
 *  of dated rows; output normalizes ts to YYYY-MM-DD (cheap string equality
 *  per cell), pulls out `id` for update/delete actions, and preserves the
 *  full row in `raw` so the detail card can render every column without a
 *  second round-trip. `kind` is optional and drives chip color in the UI. */
function shapeCalendar(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const tsField = spec.ts ?? 'ts'
  const tsEndField = spec.ts_end ?? null
  const titleField = spec.title
  const kindField = spec.kind
  const events: {
    id: unknown
    date: string | null
    time: string | null
    endTime: string | null
    endDate: string | null
    title: unknown
    kind: unknown
    raw: unknown
  }[] = []
  for (const r of rows) {
    const rawTs = r && typeof r === 'object' ? getPath(r, tsField) : null
    const rawEnd = tsEndField && r && typeof r === 'object' ? getPath(r, tsEndField) : null
    events.push({
      id: r && typeof r === 'object' ? getPath(r, 'id') : null,
      date: toIsoDate(rawTs),
      time: toClockTime(rawTs),
      endDate: toIsoDate(rawEnd),
      endTime: toClockTime(rawEnd),
      title: titleField && r && typeof r === 'object' ? getPath(r, titleField) : null,
      kind: kindField && r && typeof r === 'object' ? getPath(r, kindField) : null,
      raw: r,
    })
  }
  // Renderer needs to know which raw column holds start/end so drag-to-
  // reschedule + the From/To form labels can target the right keys without
  // re-reading the binding.
  return { events, fields: { start: tsField, end: tsEndField } }
}

function toClockTime(v: unknown): string | null {
  if (typeof v === 'string') {
    const m = /T(\d{2}:\d{2})/.exec(v) ?? /\s(\d{2}:\d{2})/.exec(v)
    if (m) return m[1] ?? null
    return null
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return null
}

function toIsoDate(v: unknown): string | null {
  if (typeof v === 'string') {
    // Already ISO date or datetime — slice the YYYY-MM-DD prefix.
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
    if (m) return m[1] ?? null
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10)
    return null
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Heuristic: < 10^12 → seconds, else milliseconds.
    const ms = v < 1e12 ? v * 1000 : v
    return new Date(ms).toISOString().slice(0, 10)
  }
  return null
}

function shapeMarkdown(
  raw: unknown,
  rows: unknown[],
  spec: MapSpec,
): Record<string, unknown> {
  const path = spec.text
  // 1) explicit path into first row
  if (path && rows.length > 0) {
    const v = getPath(rows[0], path)
    if (typeof v === 'string') return { text: v }
    if (v != null) return { text: String(v) }
  }
  // 2) explicit path into raw root
  if (path && raw && typeof raw === 'object') {
    const v = getPath(raw, path)
    if (typeof v === 'string') return { text: v }
    if (v != null) return { text: String(v) }
  }
  // 3) raw itself a string (e.g., MCP text response)
  if (typeof raw === 'string') return { text: raw }
  // 4) fallback: stringify
  try {
    return { text: JSON.stringify(raw, null, 2) }
  } catch {
    return { text: String(raw ?? '') }
  }
}

function shapeMetricGrid(rows: unknown[], spec: MapSpec): Record<string, unknown> {
  const cells = Array.isArray(spec.cells) ? spec.cells : []
  const out = cells.slice(0, 6).map((cell) => {
    const cellRows = cell.filter ? filterRows(rows, cell.filter) : rows
    const agg = (cell.aggregate ?? 'count').toLowerCase()
    const field = cell.field
    const nums: number[] = []
    if (field) {
      for (const r of cellRows) {
        const v = r && typeof r === 'object' ? getPath(r, field) : (r as unknown)
        const n = Number(v)
        if (Number.isFinite(n)) nums.push(n)
      }
    }
    let value: unknown
    if (agg === 'count') value = cellRows.length
    else if (agg === 'sum') value = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : 0
    else if (agg === 'avg')
      value = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
    else if (agg === 'min') value = nums.length > 0 ? Math.min(...nums) : 0
    else if (agg === 'max') value = nums.length > 0 ? Math.max(...nums) : 0
    else if (agg === 'first')
      value = nums[0] ?? (cellRows.length > 0 ? cellRows[0] : null)
    else value = cellRows.length
    const delta =
      cell.delta_field && cellRows[0] && typeof cellRows[0] === 'object'
        ? getPath(cellRows[0], cell.delta_field)
        : null
    return { label: cell.label, value, hint: cell.hint ?? null, delta }
  })
  return { cells: out }
}
