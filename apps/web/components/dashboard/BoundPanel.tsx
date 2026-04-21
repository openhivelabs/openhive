'use client'

import { useState } from 'react'
import { usePanelData } from '@/lib/hooks/usePanelData'
import type { CellAction, PanelSpec } from '@/lib/api/dashboards'

/** Renders a panel whose `binding` is set — data comes from the server's
 *  block cache (refreshed by the scheduler). The frontend is dumb: it trusts
 *  the mapper has already shaped the response to match the block's type.
 *
 *  A Cell is an interactive unit inside a panel (table row, kanban card, list
 *  item). When the binding declares `map.on_click`, Cells become clickable
 *  and trigger the action (detail modal, open URL, …). */
export function BoundPanel({ spec }: { spec: PanelSpec }) {
  const { data, error } = usePanelData(spec.id, true)
  const onClick = spec.binding?.map?.on_click ?? null

  if (error && data == null) {
    return (
      <div className="p-4 text-[13px] text-red-600 dark:text-red-400 font-mono whitespace-pre-wrap">
        {error}
      </div>
    )
  }
  if (data == null) {
    return <div className="p-4 text-[13px] text-neutral-400">Loading…</div>
  }
  return <PanelShape panelType={spec.type} data={data} props={spec.props} onClick={onClick} />
}

/** Pure renderer — takes (type, data, props) and draws using the per-type
 *  views below. Used by BoundPanel AND by the Add-Panel modal's preview,
 *  so users see their panel in its real visual form before saving. */
export function PanelShape({
  panelType,
  data,
  props,
  onClick,
}: {
  panelType: string
  data: unknown
  props?: Record<string, unknown>
  onClick?: CellAction | null
}) {
  const [detail, setDetail] = useState<unknown>(null)

  const dispatch = (raw: unknown) => {
    if (!onClick) return
    if (onClick.kind === 'detail') {
      setDetail(raw)
      return
    }
    if (onClick.kind === 'open_url') {
      const url = pickPath(raw, onClick.url_field)
      if (typeof url === 'string' && url.length > 0) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      return
    }
  }

  const body = (() => {
    switch (panelType) {
      case 'kpi':
        return <KpiView data={data as KpiShape} hint={String(props?.hint ?? '')} />
      case 'table':
        return <TableView data={data as TableShape} onCellClick={onClick ? dispatch : null} />
      case 'kanban':
        return <KanbanView data={data as KanbanShape} onCellClick={onClick ? dispatch : null} />
      case 'chart':
        return <ChartView data={data as ChartShape} />
      case 'list':
        return <ListView data={data as ListShape} onCellClick={onClick ? dispatch : null} />
      case 'note':
        return (
          <div className="p-3 text-[14px] text-neutral-600 dark:text-neutral-300 whitespace-pre-wrap">
            {String(props?.text ?? '')}
          </div>
        )
      default:
        return (
          <pre className="p-3 text-[12px] font-mono text-neutral-500 overflow-auto">
            {JSON.stringify(data, null, 2)}
          </pre>
        )
    }
  })()

  return (
    <>
      {body}
      {detail != null && <DetailModal raw={detail} onClose={() => setDetail(null)} />}
    </>
  )
}

// ---------- per-type renderers ----------------------------------------------

interface KpiShape {
  value: number | string | null
  rows_considered?: number
}
function KpiView({ data, hint }: { data: KpiShape; hint: string }) {
  const display =
    typeof data.value === 'number'
      ? Intl.NumberFormat().format(data.value)
      : String(data.value ?? '—')
  return (
    <div className="h-full flex flex-col justify-between p-4">
      <div className="text-[13px] text-neutral-400">{hint}</div>
      <div className="text-[32px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight">
        {display}
      </div>
    </div>
  )
}

interface TableShape {
  columns: string[]
  rows: Record<string, unknown>[]
}
function TableView({
  data,
  onCellClick,
}: {
  data: TableShape
  onCellClick: ((raw: unknown) => void) | null
}) {
  if (!data.rows?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(no rows)</div>
  }
  const clickable = !!onCellClick
  return (
    <table className="w-full text-[13px]">
      <thead className="bg-neutral-50 dark:bg-neutral-900 sticky top-0">
        <tr>
          {data.columns.map((c) => (
            <th
              key={c}
              className="text-left font-medium text-neutral-500 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr
            key={i}
            onClick={clickable ? () => onCellClick!(r) : undefined}
            className={
              'hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ' +
              (clickable ? 'cursor-pointer' : '')
            }
          >
            {data.columns.map((c) => (
              <td
                key={c}
                className="px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100 truncate"
              >
                {fmt(r[c])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface KanbanShape {
  groups: { key: string; label: string; items: { title: unknown; value: unknown; raw: unknown }[] }[]
}
function KanbanView({
  data,
  onCellClick,
}: {
  data: KanbanShape
  onCellClick: ((raw: unknown) => void) | null
}) {
  const clickable = !!onCellClick
  return (
    <div className="h-full flex gap-2 p-3 overflow-x-auto">
      {data.groups?.map((g) => (
        <div
          key={g.key}
          className="w-[200px] shrink-0 rounded-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 flex flex-col"
        >
          <div className="px-2 py-1.5 text-[13px] font-medium text-neutral-600 dark:text-neutral-300 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
            <span className="truncate">{g.label}</span>
            <span className="text-neutral-400 font-mono">{g.items.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
            {g.items.length === 0 ? (
              <div className="text-[13px] text-neutral-300 text-center py-6">—</div>
            ) : (
              g.items.map((it, i) => (
                <div
                  key={i}
                  onClick={clickable ? () => onCellClick!(it.raw) : undefined}
                  className={
                    'rounded-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 p-2 hover:border-amber-300 ' +
                    (clickable ? 'cursor-pointer' : '')
                  }
                >
                  <div className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100 truncate">
                    {fmt(it.title)}
                  </div>
                  {it.value != null && (
                    <div className="text-[12px] text-neutral-500 font-mono mt-0.5">
                      {fmt(it.value)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

interface ChartShape {
  x: string[]
  y: number[]
  series?: { name: string; data: number[] }[]
}
function ChartView({ data }: { data: ChartShape }) {
  const max = Math.max(1, ...(data.y ?? []))
  return (
    <div className="p-3 space-y-2">
      {(data.x ?? []).map((label, i) => {
        const v = data.y?.[i] ?? 0
        const pct = Math.round((v / max) * 100)
        return (
          <div key={label}>
            <div className="flex items-center justify-between text-[12.5px] text-neutral-500 mb-0.5">
              <span className="truncate">{label}</span>
              <span className="font-mono">{Intl.NumberFormat().format(v)}</span>
            </div>
            <div className="h-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-amber-400"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface ListShape {
  items: { title: unknown; value: unknown; raw: unknown }[]
}
function ListView({
  data,
  onCellClick,
}: {
  data: ListShape
  onCellClick: ((raw: unknown) => void) | null
}) {
  if (!data.items?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(empty)</div>
  }
  const clickable = !!onCellClick
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {data.items.map((it, i) => (
        <li
          key={i}
          onClick={clickable ? () => onCellClick!(it.raw) : undefined}
          className={
            'px-3 py-2 flex items-center justify-between gap-3 ' +
            (clickable ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50' : '')
          }
        >
          <span className="text-[13px] text-neutral-800 dark:text-neutral-100 truncate">
            {fmt(it.title)}
          </span>
          {it.value != null && (
            <span className="text-[12px] text-neutral-500 font-mono shrink-0">
              {fmt(it.value)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------- detail modal ----------------------------------------------------

function DetailModal({ raw, onClose }: { raw: unknown; onClose: () => void }) {
  const entries = toEntries(raw)
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-md shadow-xl max-w-[560px] w-full max-h-[80vh] overflow-hidden flex flex-col border border-neutral-200 dark:border-neutral-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            상세
          </div>
          <button
            onClick={onClose}
            className="text-[18px] text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 leading-none"
          >
            ×
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {entries.length === 0 ? (
            <pre className="text-[12px] font-mono text-neutral-500 whitespace-pre-wrap">
              {JSON.stringify(raw, null, 2)}
            </pre>
          ) : (
            <dl className="grid grid-cols-[140px_1fr] gap-y-2 gap-x-4 text-[13px]">
              {entries.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-neutral-500 truncate">{k}</dt>
                  <dd className="text-neutral-800 dark:text-neutral-100 font-mono break-all whitespace-pre-wrap">
                    {fmt(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- helpers ---------------------------------------------------------

function fmt(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'number') return Intl.NumberFormat().format(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function toEntries(raw: unknown): [string, unknown][] {
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
  }
  return []
}

function pickPath(raw: unknown, path: string): unknown {
  if (raw == null || typeof raw !== 'object') return undefined
  let cur: unknown = raw
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
