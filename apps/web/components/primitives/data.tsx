import { ArrowDown, ArrowUp, Minus } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import type { PrimitiveCatalogEntry, PrimitiveSpec } from '@/lib/primitives/types'

type C = { spec: PrimitiveSpec; children?: ReactNode }

// ─── kpi ─────────────────────────────────────────────────────────────────

export function Kpi({ spec }: C) {
  const label = str(spec.config?.label, '')
  const value = spec.config?.value
  const delta = typeof spec.config?.delta === 'number' ? (spec.config.delta as number) : null
  const unit = str(spec.config?.unit, '')
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3.5 py-3 min-w-[120px]">
      {label && (
        <div className="text-[12px] text-neutral-500 dark:text-neutral-400 font-medium truncate">
          {label}
        </div>
      )}
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[22px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100 tabular-nums">
          {String(value ?? '—')}
        </span>
        {unit && <span className="text-[13px] text-neutral-500">{unit}</span>}
      </div>
      {delta !== null && (
        <div
          className={clsx(
            'mt-1 inline-flex items-center gap-0.5 text-[11px] font-mono',
            delta > 0 ? 'text-emerald-600' : delta < 0 ? 'text-red-600' : 'text-neutral-400',
          )}
        >
          {delta > 0 ? <ArrowUp className="w-3 h-3" /> : delta < 0 ? <ArrowDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
          {Math.abs(delta)}%
        </div>
      )}
    </div>
  )
}

export const kpiCatalog: PrimitiveCatalogEntry = {
  name: 'kpi',
  summary: 'Single metric with large number.',
  description:
    'Use for headline figures: revenue, count, rate. Optional delta shows trend arrow. Pair multiple KPIs with `columns` or `grid`.',
  configSchema: {
    label: 'string',
    value: 'string | number',
    unit: 'string?',
    delta: 'number? (percent change)',
  },
  accepts_children: false,
  examples: [
    { primitive: 'kpi', config: { label: 'Active users', value: 1248, delta: 4.2 } },
    { primitive: 'kpi', config: { label: 'MRR', value: '$12.4k', delta: -1.3 } },
  ],
}

// ─── table ───────────────────────────────────────────────────────────────

interface Column {
  key: string
  label?: string
  align?: 'left' | 'right' | 'center'
}

export function Table({ spec }: C) {
  const columns = (Array.isArray(spec.config?.columns) ? spec.config.columns : []) as Column[]
  const rows = (Array.isArray(spec.config?.rows) ? spec.config.rows : []) as Record<string, unknown>[]
  const compact = Boolean(spec.config?.compact)

  if (rows.length === 0) {
    return <Empty hint="No rows" />
  }

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 overflow-hidden bg-white dark:bg-neutral-900">
      <table className="w-full text-[13px]">
        <thead className="bg-neutral-50 dark:bg-neutral-900/50 border-b border-neutral-200 dark:border-neutral-800">
          <tr className="text-left">
            {columns.map((col) => (
              <th
                key={col.key}
                className={clsx(
                  'px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                )}
              >
                {col.label ?? col.key}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map((row, idx) => (
            <tr key={String(row.id ?? idx)} className={clsx(compact ? '' : 'h-10')}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={clsx(
                    'px-3 py-1.5 text-neutral-800 dark:text-neutral-200 truncate',
                    col.align === 'right' && 'text-right tabular-nums',
                    col.align === 'center' && 'text-center',
                  )}
                >
                  {formatCell(row[col.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const tableCatalog: PrimitiveCatalogEntry = {
  name: 'table',
  summary: 'Data table with configurable columns.',
  description:
    'Rows × columns grid. Each column has a `key`; row values are looked up by that key. Use `compact` for denser rows.',
  configSchema: {
    columns: "{key: string, label?: string, align?: 'left'|'right'|'center'}[]",
    rows: 'Record<string, any>[]',
    compact: 'boolean?',
  },
  accepts_children: false,
  emits: ['selected'],
  examples: [
    {
      primitive: 'table',
      config: {
        columns: [
          { key: 'name', label: 'Name' },
          { key: 'stage', label: 'Stage' },
          { key: 'value', label: 'Value', align: 'right' },
        ],
        rows: [
          { id: 1, name: 'Acme', stage: 'Won', value: 50000 },
          { id: 2, name: 'Globex', stage: 'Proposal', value: 120000 },
        ],
      },
    },
  ],
}

// ─── list ────────────────────────────────────────────────────────────────

interface ListItem {
  title: string
  subtitle?: string
  meta?: string
  icon?: string
}

export function List({ spec }: C) {
  const items = (Array.isArray(spec.config?.items) ? spec.config.items : []) as ListItem[]
  if (items.length === 0) return <Empty hint="Empty" />
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      {items.map((it, i) => (
        <li key={`${it.title}-${i}`} className="px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium truncate text-neutral-900 dark:text-neutral-100">
                {it.title}
              </div>
              {it.subtitle && (
                <div className="text-[12px] text-neutral-500 mt-0.5 truncate">{it.subtitle}</div>
              )}
            </div>
            {it.meta && (
              <div className="shrink-0 text-[11px] text-neutral-400 font-mono">{it.meta}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

export const listCatalog: PrimitiveCatalogEntry = {
  name: 'list',
  summary: 'Vertical list of items with title + subtitle + meta.',
  description:
    'Lighter alternative to `table` when columns are not uniform. Good for activity feeds, recent items, simple lookups.',
  configSchema: { items: '{title: string, subtitle?: string, meta?: string}[]' },
  accepts_children: false,
  examples: [
    {
      primitive: 'list',
      config: {
        items: [
          { title: 'Invoice #42 paid', subtitle: 'Acme Corp · $4,200', meta: '2m ago' },
          { title: 'New contact added', subtitle: 'globex.com', meta: '1h ago' },
        ],
      },
    },
  ],
}

// ─── kanban ──────────────────────────────────────────────────────────────

interface KanbanColumn {
  key: string
  label: string
  cards: { title: string; subtitle?: string; meta?: string }[]
}

export function Kanban({ spec }: C) {
  const columns = (Array.isArray(spec.config?.columns)
    ? spec.config.columns
    : []) as KanbanColumn[]
  return (
    <div className="flex gap-3 overflow-x-auto">
      {columns.map((col) => (
        <div
          key={col.key}
          className="w-[220px] shrink-0 bg-neutral-100/60 dark:bg-neutral-900/40 rounded-sm border border-neutral-200 dark:border-neutral-800"
        >
          <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
            <span className="text-[12px] font-medium uppercase tracking-wider text-neutral-600 dark:text-neutral-400">
              {col.label}
            </span>
            <span className="text-[11px] font-mono text-neutral-400">{col.cards.length}</span>
          </div>
          <div className="p-2 space-y-1.5 min-h-[60px]">
            {col.cards.map((card, i) => (
              <div
                key={`${card.title}-${i}`}
                className="rounded-sm border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-2.5 py-1.5"
              >
                <div className="text-[13px] font-medium truncate">{card.title}</div>
                {card.subtitle && (
                  <div className="text-[11px] text-neutral-500 mt-0.5 truncate">{card.subtitle}</div>
                )}
                {card.meta && (
                  <div className="text-[11px] text-neutral-400 mt-1 font-mono">{card.meta}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export const kanbanCatalog: PrimitiveCatalogEntry = {
  name: 'kanban',
  summary: 'Grouped columns of cards (stages, statuses).',
  description:
    'Use for pipelines, workflows, or any status-grouped set of items. Horizontally scrollable.',
  configSchema: { columns: '{key: string, label: string, cards: Card[]}[]' },
  accepts_children: false,
  examples: [
    {
      primitive: 'kanban',
      config: {
        columns: [
          {
            key: 'todo',
            label: 'To do',
            cards: [{ title: 'Write spec', subtitle: 'Owner: Ana' }],
          },
          { key: 'done', label: 'Done', cards: [] },
        ],
      },
    },
  ],
}

// ─── chart ───────────────────────────────────────────────────────────────

interface ChartPoint {
  label: string
  value: number
}

export function Chart({ spec }: C) {
  const kind = str(spec.config?.kind, 'bar') as 'bar' | 'line' | 'pie'
  const data = (Array.isArray(spec.config?.data) ? spec.config.data : []) as ChartPoint[]
  const height = num(spec.config?.height, 160)

  if (data.length === 0) return <Empty hint="No data" />

  if (kind === 'pie') return <PieChart data={data} height={height} />
  if (kind === 'line') return <LineChart data={data} height={height} />
  return <BarChart data={data} height={height} />
}

function BarChart({ data, height }: { data: ChartPoint[]; height: number }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="flex-1 flex flex-col items-center justify-end min-w-0">
            <div
              className="w-full bg-neutral-800 dark:bg-neutral-200 rounded-t-sm"
              style={{ height: `${(d.value / max) * 100}%` }}
              title={`${d.label}: ${d.value}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex-1 text-[10px] text-neutral-500 text-center truncate">
            {d.label}
          </div>
        ))}
      </div>
    </div>
  )
}

function LineChart({ data, height }: { data: ChartPoint[]; height: number }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const w = 400
  const h = height
  const pad = 6
  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2)
    const y = h - pad - ((d.value - min) / Math.max(max - min, 1)) * (h - pad * 2)
    return `${x},${y}`
  }).join(' ')
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-neutral-800 dark:text-neutral-200"
        />
      </svg>
    </div>
  )
}

function PieChart({ data, height }: { data: ChartPoint[]; height: number }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1
  const palette = ['#525252', '#737373', '#a3a3a3', '#d4d4d4', '#e5e5e5', '#f5f5f5']
  let acc = 0
  const arcs = data.map((d, i) => {
    const start = (acc / total) * 2 * Math.PI
    acc += d.value
    const end = (acc / total) * 2 * Math.PI
    return arcPath(50, 50, 40, start, end, i)
  })
  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 flex items-center gap-4">
      <svg viewBox="0 0 100 100" style={{ height, width: height }}>
        {arcs.map((a, i) => (
          <path key={`arc-${i}-${a}`} d={a} fill={palette[i % palette.length]} />
        ))}
      </svg>
      <ul className="text-[12px] space-y-1">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-sm"
              style={{ background: palette[i % palette.length] }}
            />
            <span className="text-neutral-700 dark:text-neutral-300">{d.label}</span>
            <span className="text-neutral-400 font-mono ml-auto tabular-nums">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function arcPath(cx: number, cy: number, r: number, start: number, end: number, _i: number): string {
  const x1 = cx + r * Math.cos(start - Math.PI / 2)
  const y1 = cy + r * Math.sin(start - Math.PI / 2)
  const x2 = cx + r * Math.cos(end - Math.PI / 2)
  const y2 = cy + r * Math.sin(end - Math.PI / 2)
  const large = end - start > Math.PI ? 1 : 0
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
}

export const chartCatalog: PrimitiveCatalogEntry = {
  name: 'chart',
  summary: 'Bar / line / pie chart from label-value data points.',
  description:
    'Minimal data viz. `kind` picks the shape. `data` is a flat array of {label, value}. Use `bar` by default; `line` for time series; `pie` for share-of-whole.',
  configSchema: {
    kind: "'bar' | 'line' | 'pie'",
    data: '{label: string, value: number}[]',
    height: 'number? (px, default 160)',
  },
  accepts_children: false,
  examples: [
    {
      primitive: 'chart',
      config: {
        kind: 'bar',
        data: [
          { label: 'Mon', value: 12 },
          { label: 'Tue', value: 18 },
          { label: 'Wed', value: 9 },
        ],
      },
    },
  ],
}

// ─── stat-row ────────────────────────────────────────────────────────────

export function StatRow({ spec }: C) {
  const stats = (Array.isArray(spec.config?.stats)
    ? spec.config.stats
    : []) as { label: string; value: string | number; unit?: string }[]
  return (
    <div className="flex gap-0 divide-x divide-neutral-200 dark:divide-neutral-800 rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      {stats.map((s, i) => (
        <div key={`${s.label}-${i}`} className="flex-1 px-3.5 py-2.5">
          <div className="text-[11px] text-neutral-500 uppercase tracking-wider font-medium">{s.label}</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[17px] font-semibold tracking-tight tabular-nums">{String(s.value)}</span>
            {s.unit && <span className="text-[11px] text-neutral-500">{s.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

export const statRowCatalog: PrimitiveCatalogEntry = {
  name: 'stat-row',
  summary: 'Horizontal row of compact stats.',
  description:
    'Lighter than multiple `kpi` blocks — renders a single row with divided cells. Use for dashboard headers where 3–6 metrics need to share width.',
  configSchema: { stats: '{label: string, value: any, unit?: string}[]' },
  accepts_children: false,
  examples: [
    {
      primitive: 'stat-row',
      config: {
        stats: [
          { label: 'Tasks', value: 42 },
          { label: 'Active', value: 3 },
          { label: 'Done', value: 37 },
        ],
      },
    },
  ],
}

// ─── helpers ─────────────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return v.toLocaleString()
  return String(v)
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded-md border border-dashed border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-neutral-900/40 text-[13px] text-neutral-400 text-center py-6 font-mono">
      {hint}
    </div>
  )
}
