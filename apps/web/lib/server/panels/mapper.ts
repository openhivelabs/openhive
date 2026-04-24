/**
 * Declarative mapper — turn raw source data into block-shape data.
 * Ports apps/server/openhive/panels/mapper.py.
 *
 * Dependency-free at runtime: jsonpath-plus for row extraction, a tiny
 * in-line expression evaluator for filters. No JS sandbox, no AI-generated
 * code — declarative selectors only.
 */

import { JSONPath } from 'jsonpath-plus'

export interface MapSpec {
  rows?: string
  group_by?: string
  title?: string
  value?: string
  columns?: string[]
  filter?: string
  aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'first'
  aggregate_field?: string
  ts?: string
  kind?: string
  text?: string
  cells?: MetricCellSpec[]
}

export interface MetricCellSpec {
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
  return { value: result, rows_considered: rows.length }
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
  const yField = spec.value
  if (!xField) return { series: [], x: [], y: [] }
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
