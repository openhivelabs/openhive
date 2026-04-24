import type React from 'react'
import { useState } from 'react'
import { Plus, TrashSimple, Warning } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { usePanelData } from '@/lib/hooks/usePanelData'
import type { CellAction, PanelAction, PanelSpec } from '@/lib/api/dashboards'
import { refreshPanel } from '@/lib/api/panels'
import { useT } from '@/lib/i18n'
import { ActionFormModal, runConfirmAction } from './ActionForm'

/** Renders a panel whose `binding` is set — data comes from the server's
 *  block cache (refreshed by the scheduler). The frontend is dumb: it trusts
 *  the mapper has already shaped the response to match the block's type.
 *
 *  A Cell is an interactive unit inside a panel (table row, kanban card, list
 *  item). When the binding declares `map.on_click`, Cells become clickable
 *  and trigger the action (detail modal, open URL, …). */
export function BoundPanel({ spec, teamId }: { spec: PanelSpec; teamId?: string }) {
  const t = useT()
  const { data, error, shapeChanged } = usePanelData(spec.id, true)
  const onClick = spec.binding?.map?.on_click ?? null
  const actions = spec.binding?.actions ?? []
  const toolbarActions = actions.filter((a) => a.placement === 'toolbar')
  const rowActions = actions.filter((a) => a.placement === 'row')
  const inlineActions = actions.filter((a) => a.placement === 'inline')
  const [openAction, setOpenAction] = useState<PanelAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const handleRefresh = async () => {
    try {
      await refreshPanel(spec.id)
    } catch {
      /* usePanelData surfaces error on next stream tick */
    }
  }

  const hasToolbar = (teamId && toolbarActions.length > 0) || shapeChanged
  const header = hasToolbar ? (
    <div className="px-3 py-1.5 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800">
      {shapeChanged && (
        <span
          title={t('panel.shapeChanged')}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800"
        >
          <Warning className="w-3 h-3" />
          <span>{t('panel.shapeChangedShort')}</span>
        </span>
      )}
      <div className="flex-1" />
      {teamId &&
        toolbarActions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => {
              if (a.form?.fields?.length) setOpenAction(a)
              else
                runConfirmAction({
                  panelId: spec.id,
                  teamId,
                  action: a,
                  values: {},
                  t,
                  onSuccess: handleRefresh,
                  onError: setActionError,
                })
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-sm text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
            title={a.label}
          >
            <Plus className="w-3 h-3" />
            <span>{a.label}</span>
          </button>
        ))}
    </div>
  ) : null

  const body = (() => {
    if (data == null) {
      if (error) return null
      return <div className="p-4 text-[13px] text-neutral-400">Loading…</div>
    }
    return (
      <PanelShape
        panelType={spec.type}
        data={data}
        props={spec.props}
        onClick={onClick}
        rowActions={rowActions}
        inlineActions={inlineActions}
        allActions={actions}
        groupBy={spec.binding?.map?.group_by}
        panelId={spec.id}
        teamId={teamId}
        onRowActionDone={handleRefresh}
        onRowActionError={setActionError}
      />
    )
  })()

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="px-3 py-1.5 text-[12px] text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-900/40 border-b border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
          <span className="inline-block w-1 h-1 rounded-full bg-neutral-400 shrink-0" />
          <span className="flex-1 truncate font-mono text-[11.5px]" title={error}>
            {friendlyError(error, t)}
          </span>
          {errorCta(error)}
        </div>
      )}
      {header}
      {actionError && (
        <div className="px-3 py-1 text-[12px] text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 flex items-center gap-1.5">
          <span className="flex-1 truncate">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="underline hover:no-underline cursor-pointer"
          >
            OK
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">{body}</div>
      {openAction && teamId && (
        <ActionFormModal
          panelId={spec.id}
          teamId={teamId}
          action={openAction}
          onClose={() => setOpenAction(null)}
          onSuccess={handleRefresh}
        />
      )}
    </div>
  )
}

function errorCta(raw: string): React.ReactNode {
  const cred = raw.match(/missing credential:\s*"([^"]+)"/i)
  if (cred?.[1]) {
    const href = `/settings?section=credentials&prefill_ref=${encodeURIComponent(cred[1])}`
    return (
      <a
        href={href}
        className="shrink-0 text-neutral-600 dark:text-neutral-200 hover:underline"
      >
        Set up
      </a>
    )
  }
  const mcp = raw.match(/MCP server "([^"]+)" is not installed/i)
  if (mcp?.[1]) {
    return (
      <a
        href="/settings?section=mcp"
        className="shrink-0 text-neutral-600 dark:text-neutral-200 hover:underline"
      >
        Install
      </a>
    )
  }
  return null
}

function friendlyError(
  raw: string,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  const s = raw.trim()
  const tbl = s.match(/no such table:\s*(\S+)/i)
  if (tbl?.[1]) return t('panel.err.noTable', { name: tbl[1] })
  const col = s.match(/no such column:\s*(\S+)/i)
  if (col?.[1]) return t('panel.err.noColumn', { name: col[1] })
  return s.replace(/^[A-Za-z]+Error:\s*/, '')
}

/** Pure renderer — takes (type, data, props) and draws using the per-type
 *  views below. Used by BoundPanel AND by the Add-Panel modal's preview,
 *  so users see their panel in its real visual form before saving. */
export function PanelShape({
  panelType,
  data,
  props,
  onClick,
  rowActions,
  inlineActions,
  allActions,
  groupBy,
  panelId,
  teamId,
  onRowActionDone,
  onRowActionError,
}: {
  panelType: string
  data: unknown
  props?: Record<string, unknown>
  onClick?: CellAction | null
  rowActions?: PanelAction[]
  inlineActions?: PanelAction[]
  allActions?: PanelAction[]
  groupBy?: string
  panelId?: string
  teamId?: string
  onRowActionDone?: () => void
  onRowActionError?: (msg: string) => void
}) {
  const t = useT()
  const [detail, setDetail] = useState<unknown>(null)

  const rowActs = rowActions ?? []
  const rowActionHandler = teamId && panelId && rowActs.length > 0
    ? async (row: Record<string, unknown>, action: PanelAction) => {
        const values: Record<string, unknown> = {}
        // Pass row's primitive fields as potential :id / :status bindings.
        for (const [k, v] of Object.entries(row)) {
          if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
            values[k] = v
          }
        }
        await runConfirmAction({
          panelId,
          teamId,
          action,
          values,
          t,
          onSuccess: onRowActionDone,
          onError: onRowActionError,
        })
      }
    : null

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
        return <KpiView data={data as KpiShape} props={props} />
      case 'table':
        return (
          <TableView
            data={data as TableShape}
            onCellClick={onClick ? dispatch : null}
            rowActions={rowActs}
            onRowAction={rowActionHandler}
            inlineActions={inlineActions ?? []}
            allActions={allActions ?? []}
            panelId={panelId}
            teamId={teamId}
            onInlineDone={onRowActionDone}
            onInlineError={onRowActionError}
            props={props}
          />
        )
      case 'kanban':
        return (
          <KanbanView
            data={data as KanbanShape}
            onCellClick={onClick ? dispatch : null}
            inlineActions={inlineActions ?? []}
            groupBy={groupBy}
            panelId={panelId}
            teamId={teamId}
            onDone={onRowActionDone}
            onError={onRowActionError}
          />
        )
      case 'chart':
        return <ChartView data={data as ChartShape} props={props} />
      case 'list':
        return (
          <ListView
            data={data as ListShape}
            onCellClick={onClick ? dispatch : null}
            props={props}
          />
        )
      case 'timeline':
        return (
          <TimelineView data={data as TimelineShape} onCellClick={onClick ? dispatch : null} />
        )
      case 'markdown':
        return <MarkdownView data={data as MarkdownShape} />
      case 'metric_grid':
        return <MetricGridView data={data as MetricGridShape} />
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
interface KpiProps {
  hint?: unknown
  delta?: { value?: number; direction?: 'up' | 'down' | 'flat'; percent?: boolean }
  sparkline?: number[]
}
function KpiView({ data, props }: { data: KpiShape; props?: Record<string, unknown> }) {
  const p = (props ?? {}) as KpiProps
  const hint = String(p.hint ?? '')
  const display =
    typeof data.value === 'number'
      ? Intl.NumberFormat().format(data.value)
      : String(data.value ?? '—')
  const delta = p.delta
  const deltaColor =
    delta?.direction === 'up'
      ? 'text-emerald-600 dark:text-emerald-400'
      : delta?.direction === 'down'
        ? 'text-red-600 dark:text-red-400'
        : 'text-neutral-500'
  const deltaArrow =
    delta?.direction === 'up' ? '▲' : delta?.direction === 'down' ? '▼' : '–'
  const spark = Array.isArray(p.sparkline) ? p.sparkline.filter((n) => Number.isFinite(n)) : []
  return (
    <div className="h-full flex flex-col justify-between p-4">
      <div className="text-[13px] text-neutral-400">{hint}</div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[32px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight truncate">
            {display}
          </div>
          {delta && typeof delta.value === 'number' && (
            <div className={`text-[12px] font-mono mt-0.5 ${deltaColor}`}>
              {deltaArrow} {Intl.NumberFormat().format(Math.abs(delta.value))}
              {delta.percent ? '%' : ''}
            </div>
          )}
        </div>
        {spark.length > 1 && <Sparkline values={spark} />}
      </div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  const w = 72
  const h = 24
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const step = values.length > 1 ? w / (values.length - 1) : w
  const points = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * h}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="shrink-0">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-neutral-400 dark:text-neutral-500"
        points={points}
      />
    </svg>
  )
}

interface TimelineShape {
  events: { ts: unknown; title: unknown; kind?: unknown; raw: unknown }[]
}
function TimelineView({
  data,
  onCellClick,
}: {
  data: TimelineShape
  onCellClick: ((raw: unknown) => void) | null
}) {
  if (!data.events?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(no events)</div>
  }
  const clickable = !!onCellClick
  return (
    <ol className="relative px-4 py-3 space-y-3">
      <div className="absolute left-[22px] top-3 bottom-3 w-px bg-neutral-200 dark:bg-neutral-800" />
      {data.events.map((e, i) => {
        const kind = e.kind != null ? String(e.kind) : null
        return (
          <li
            key={i}
            onClick={clickable ? () => onCellClick!(e.raw) : undefined}
            className={
              'relative flex items-start gap-3 pl-4 ' +
              (clickable ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/40 rounded-sm' : '')
            }
          >
            <div className="absolute left-[18px] top-[6px] w-2 h-2 rounded-full bg-neutral-400 dark:bg-neutral-500 ring-2 ring-white dark:ring-neutral-900" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] text-neutral-800 dark:text-neutral-100 truncate">
                  {fmt(e.title)}
                </span>
                {kind && (
                  <span className="text-[10.5px] font-mono px-1.5 py-[1px] rounded-sm bg-neutral-100 dark:bg-neutral-800 text-neutral-500">
                    {kind}
                  </span>
                )}
              </div>
              <div className="text-[11.5px] text-neutral-400 font-mono mt-0.5">
                {formatTs(e.ts)}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function formatTs(v: unknown): string {
  if (v == null) return ''
  let d: Date
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v)
  else if (typeof v === 'string') d = new Date(v)
  else return ''
  if (Number.isNaN(d.getTime())) return String(v)
  const diff = Date.now() - d.getTime()
  if (diff >= 0 && diff < 60_000) return 'just now'
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return d.toLocaleString()
}

interface MarkdownShape {
  text: string
}
function MarkdownView({ data }: { data: MarkdownShape }) {
  const text = String(data?.text ?? '')
  if (!text.trim()) {
    return <div className="p-4 text-[13px] text-neutral-400">(empty)</div>
  }
  return (
    <div className="p-4 prose-sm max-w-none text-[13px] text-neutral-700 dark:text-neutral-200">
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

const MARKDOWN_COMPONENTS = {
  a: (p: { href?: string; children?: React.ReactNode }) => (
    <a
      href={p.href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-neutral-900 dark:text-neutral-100 underline underline-offset-2 hover:no-underline"
    >
      {p.children}
    </a>
  ),
  p: (p: { children?: React.ReactNode }) => (
    <p className="my-1.5 leading-relaxed">{p.children}</p>
  ),
  h1: (p: { children?: React.ReactNode }) => (
    <h1 className="mt-3 mb-1.5 text-[16px] font-semibold text-neutral-900 dark:text-neutral-100">
      {p.children}
    </h1>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-1.5 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
      {p.children}
    </h2>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <h3 className="mt-2.5 mb-1 text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">
      {p.children}
    </h3>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="my-1.5 pl-5 list-disc space-y-0.5">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="my-1.5 pl-5 list-decimal space-y-0.5">{p.children}</ol>
  ),
  code: (p: { inline?: boolean; children?: React.ReactNode }) =>
    p.inline ? (
      <code className="px-1 py-[1px] rounded-sm bg-neutral-100 dark:bg-neutral-800 font-mono text-[12px]">
        {p.children}
      </code>
    ) : (
      <pre className="my-2 p-2 rounded-sm bg-neutral-100 dark:bg-neutral-800 overflow-auto">
        <code className="font-mono text-[12px]">{p.children}</code>
      </pre>
    ),
  table: (p: { children?: React.ReactNode }) => (
    <table className="my-2 w-full border-collapse text-[12.5px]">{p.children}</table>
  ),
  th: (p: { children?: React.ReactNode }) => (
    <th className="text-left px-2 py-1 border-b border-neutral-200 dark:border-neutral-700 font-medium text-neutral-600 dark:text-neutral-300">
      {p.children}
    </th>
  ),
  td: (p: { children?: React.ReactNode }) => (
    <td className="px-2 py-1 border-b border-neutral-100 dark:border-neutral-800">
      {p.children}
    </td>
  ),
}

interface MetricGridShape {
  cells: { label: string; value: number | string | null; hint?: string | null; delta?: unknown }[]
}
function MetricGridView({ data }: { data: MetricGridShape }) {
  const cells = Array.isArray(data?.cells) ? data.cells : []
  if (cells.length === 0) {
    return <div className="p-4 text-[13px] text-neutral-400">(no metrics)</div>
  }
  const cols = cells.length >= 4 ? 'grid-cols-2 md:grid-cols-3' : `grid-cols-${cells.length}`
  return (
    <div className={`grid ${cols} gap-3 p-3`}>
      {cells.map((c, i) => {
        const display =
          typeof c.value === 'number'
            ? Intl.NumberFormat().format(c.value)
            : String(c.value ?? '—')
        const deltaStr =
          c.delta == null
            ? null
            : typeof c.delta === 'number'
              ? Intl.NumberFormat().format(c.delta)
              : String(c.delta)
        return (
          <div
            key={i}
            className="flex flex-col gap-0.5 p-3 rounded-sm bg-neutral-50 dark:bg-neutral-800/40 border border-neutral-100 dark:border-neutral-800"
          >
            <div className="text-[11.5px] uppercase tracking-wider text-neutral-400 truncate">
              {c.label}
            </div>
            <div className="text-[22px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight truncate">
              {display}
            </div>
            {c.hint && <div className="text-[11.5px] text-neutral-500 truncate">{c.hint}</div>}
            {deltaStr != null && (
              <div className="text-[11.5px] font-mono text-neutral-500">{deltaStr}</div>
            )}
          </div>
        )
      })}
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
  rowActions,
  onRowAction,
  inlineActions,
  allActions,
  panelId,
  teamId,
  onInlineDone,
  onInlineError,
  props,
}: {
  data: TableShape
  onCellClick: ((raw: unknown) => void) | null
  rowActions?: PanelAction[]
  onRowAction?: ((row: Record<string, unknown>, action: PanelAction) => void) | null
  inlineActions?: PanelAction[]
  allActions?: PanelAction[]
  panelId?: string
  teamId?: string
  onInlineDone?: () => void
  onInlineError?: (msg: string) => void
  props?: Record<string, unknown>
}) {
  const colFormatters =
    (props?.column_formatters as Record<string, ColumnFormat> | undefined) ?? {}
  const [editing, setEditing] = useState<{ rowIdx: number; col: string } | null>(null)
  // Map column → first inline action that lists it in `fields`.
  const inlineByCol = new Map<string, PanelAction>()
  for (const a of inlineActions ?? []) {
    for (const f of a.fields ?? []) {
      if (!inlineByCol.has(f)) inlineByCol.set(f, a)
    }
  }
  const commitInline = async (
    row: Record<string, unknown>,
    col: string,
    newValue: unknown,
  ) => {
    const action = inlineByCol.get(col)
    if (!action || !panelId || !teamId) {
      setEditing(null)
      return
    }
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const values: Record<string, unknown> = { ...row, [col]: newValue }
      // Keep only primitives (ids etc) — excludes nested objects.
      for (const [k, v] of Object.entries(values)) {
        if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
          delete values[k]
        }
      }
      await executePanelAction(panelId, action.id, teamId, values)
      onInlineDone?.()
    } catch (e) {
      onInlineError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setEditing(null)
    }
  }
  if (!data.rows?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(no rows)</div>
  }
  const clickable = !!onCellClick
  const acts = rowActions ?? []
  const hasActions = acts.length > 0 && !!onRowAction
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
          {hasActions && (
            <th className="w-10 border-b border-neutral-200 dark:border-neutral-800" />
          )}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r, i) => (
          <tr
            key={i}
            onClick={clickable ? () => onCellClick!(r) : undefined}
            className={
              'group hover:bg-neutral-50 dark:hover:bg-neutral-800/50 ' +
              (clickable ? 'cursor-pointer' : '')
            }
          >
            {data.columns.map((c) => {
              const editable = inlineByCol.has(c)
              const isEditing = editing?.rowIdx === i && editing.col === c
              return (
                <td
                  key={c}
                  onClick={(e) => {
                    // Editable cells own their own click semantics — don't let
                    // the row-level "open detail" handler eat the user's
                    // double-click, and keep single-click focused on the cell.
                    if (editable || isEditing) e.stopPropagation()
                  }}
                  onDoubleClick={(e) => {
                    if (!editable) return
                    e.stopPropagation()
                    setEditing({ rowIdx: i, col: c })
                  }}
                  className={clsx(
                    'px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100 truncate',
                    editable && !isEditing && 'cursor-text hover:outline-1 hover:outline-dashed hover:outline-amber-300',
                  )}
                >
                  {isEditing ? (
                    <InlineCellInput
                      action={inlineByCol.get(c)!}
                      allActions={allActions ?? []}
                      column={c}
                      initial={r[c]}
                      onCommit={(v) => commitInline(r, c, v)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    formatCell(r[c], colFormatters[c])
                  )}
                </td>
              )
            })}
            {hasActions && (
              <td className="px-1 border-b border-neutral-100 dark:border-neutral-800 text-right">
                <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {acts.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRowAction!(r, a)
                      }}
                      aria-label={a.label}
                      title={a.label}
                      className={clsx(
                        'w-6 h-6 flex items-center justify-center rounded-sm cursor-pointer',
                        a.kind === 'delete'
                          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40'
                          : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                    >
                      {a.kind === 'delete' ? (
                        <TrashSimple className="w-3.5 h-3.5" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                    </button>
                  ))}
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function InlineCellInput({
  action,
  allActions,
  column,
  initial,
  onCommit,
  onCancel,
}: {
  action: PanelAction
  allActions?: PanelAction[]
  column: string
  initial: unknown
  onCommit: (v: unknown) => void
  onCancel: () => void
}) {
  // Inline update actions usually declare just the mutated column names
  // (`fields: [status]`) without repeating a full FormField schema. To pick
  // the right control (text vs select vs number), we look across EVERY action
  // on this panel for a matching field definition — the `create` action's
  // form typically has the richest schema (type, options, min/max) and we
  // borrow that rather than fall through to a bare text input.
  const field =
    action.form?.fields?.find((f) => f.name === column) ??
    (allActions ?? [])
      .flatMap((a) => a.form?.fields ?? [])
      .find((f) => f.name === column)
  const [value, setValue] = useState<string>(() =>
    initial === null || initial === undefined ? '' : String(initial),
  )
  const commit = () => {
    if (field?.type === 'number') onCommit(value === '' ? null : Number(value))
    else if (field?.type === 'toggle') onCommit(value === 'true')
    else onCommit(value)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit()
    else if (e.key === 'Escape') onCancel()
  }
  const base =
    'w-full px-1.5 py-0.5 rounded-sm text-[13px] border border-amber-400 bg-white dark:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-amber-400/60'
  if (field?.type === 'select') {
    return (
      <select
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        className={base}
      >
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      autoFocus
      type={field?.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className={base}
    />
  )
}

interface KanbanShape {
  groups: { key: string; label: string; items: { title: unknown; value: unknown; raw: unknown }[] }[]
}
function KanbanView({
  data,
  onCellClick,
  inlineActions,
  groupBy,
  panelId,
  teamId,
  onDone,
  onError,
}: {
  data: KanbanShape
  onCellClick: ((raw: unknown) => void) | null
  inlineActions?: PanelAction[]
  groupBy?: string
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
}) {
  const clickable = !!onCellClick
  const [dragCard, setDragCard] = useState<{ raw: Record<string, unknown>; from: string } | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)

  // Pick the inline action that targets the kanban's group_by field.
  const moveAction =
    groupBy && inlineActions
      ? inlineActions.find((a) => (a.fields ?? []).includes(groupBy))
      : undefined
  const canDrag = !!(moveAction && panelId && teamId && groupBy)

  const handleDrop = async (toKey: string) => {
    if (!dragCard || !moveAction || !canDrag) return
    if (dragCard.from === toKey) {
      setDragCard(null)
      setHoverKey(null)
      return
    }
    const row = dragCard.raw
    const values: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        values[k] = v
      }
    }
    values[groupBy!] = toKey
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      await executePanelAction(panelId!, moveAction.id, teamId!, values)
      onDone?.()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setDragCard(null)
      setHoverKey(null)
    }
  }

  return (
    <div className="h-full flex gap-2 p-3 overflow-x-auto">
      {data.groups?.map((g) => {
        const isHover = hoverKey === g.key && dragCard && dragCard.from !== g.key
        return (
          <div
            key={g.key}
            onDragOver={(e) => {
              if (!canDrag) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (hoverKey !== g.key) setHoverKey(g.key)
            }}
            onDragLeave={() => setHoverKey((v) => (v === g.key ? null : v))}
            onDrop={(e) => {
              e.preventDefault()
              void handleDrop(g.key)
            }}
            className={clsx(
              'w-[200px] shrink-0 rounded-sm bg-neutral-50 dark:bg-neutral-900 border flex flex-col',
              isHover
                ? 'border-amber-400 ring-1 ring-amber-300'
                : 'border-neutral-200 dark:border-neutral-800',
            )}
          >
            <div className="px-2 py-1.5 text-[13px] font-medium text-neutral-600 dark:text-neutral-300 flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800">
              <span className="truncate">{g.label}</span>
              <span className="text-neutral-400 font-mono">{g.items.length}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
              {g.items.length === 0 ? (
                <div className="text-[13px] text-neutral-300 text-center py-6">—</div>
              ) : (
                g.items.map((it, i) => {
                  const raw = it.raw as Record<string, unknown>
                  return (
                    <div
                      key={i}
                      draggable={canDrag}
                      onDragStart={(e) => {
                        if (!canDrag) return
                        e.dataTransfer.effectAllowed = 'move'
                        setDragCard({ raw, from: g.key })
                      }}
                      onDragEnd={() => {
                        setDragCard(null)
                        setHoverKey(null)
                      }}
                      onClick={clickable ? () => onCellClick!(it.raw) : undefined}
                      className={clsx(
                        'rounded-sm bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 p-2 hover:border-amber-300',
                        clickable && 'cursor-pointer',
                        canDrag && 'active:cursor-grabbing',
                        dragCard?.raw === raw && 'opacity-40',
                      )}
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
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface ChartShape {
  x: string[]
  y: number[]
  series?: { name: string; data: number[] }[]
}
function ChartView({ data, props }: { data: ChartShape; props?: Record<string, unknown> }) {
  const variant = (props?.variant as 'bar' | 'line' | 'area' | undefined) ?? 'bar'
  const goal =
    typeof props?.goal_line === 'number' && Number.isFinite(props.goal_line as number)
      ? (props.goal_line as number)
      : null
  const xs = data.x ?? []
  const ys = data.y ?? []
  const max = Math.max(1, ...(goal != null ? [...ys, goal] : ys))

  if (variant === 'line' || variant === 'area') {
    const w = 100
    const h = 40
    const step = ys.length > 1 ? w / (ys.length - 1) : w
    const points = ys.map((v, i) => `${i * step},${h - (v / max) * h}`)
    const polyline = points.join(' ')
    const area = `0,${h} ${polyline} ${w},${h}`
    const goalY = goal != null ? h - (goal / max) * h : null
    return (
      <div className="p-3">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-32">
          {variant === 'area' && (
            <polygon points={area} className="fill-neutral-200 dark:fill-neutral-700/60" />
          )}
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            className="text-neutral-700 dark:text-neutral-200"
            points={polyline}
          />
          {goalY != null && (
            <line
              x1="0"
              y1={goalY}
              x2={w}
              y2={goalY}
              stroke="currentColor"
              strokeDasharray="2,2"
              strokeWidth="0.5"
              className="text-emerald-500"
            />
          )}
        </svg>
        <div className="mt-2 grid grid-cols-4 gap-1 text-[10.5px] text-neutral-400 font-mono">
          {xs.map((label, i) => (
            <span key={`${label}-${i}`} className="truncate">
              {label}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 space-y-2">
      {goal != null && (
        <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono">
          goal {Intl.NumberFormat().format(goal)}
        </div>
      )}
      {xs.map((label, i) => {
        const v = ys[i] ?? 0
        const pct = Math.round((v / max) * 100)
        const goalPct = goal != null ? Math.round((goal / max) * 100) : null
        return (
          <div key={`${label}-${i}`}>
            <div className="flex items-center justify-between text-[12.5px] text-neutral-500 mb-0.5">
              <span className="truncate">{label}</span>
              <span className="font-mono">{Intl.NumberFormat().format(v)}</span>
            </div>
            <div className="relative h-1.5 bg-neutral-100 dark:bg-neutral-800 rounded-sm overflow-hidden">
              <div
                className="h-full bg-neutral-700 dark:bg-neutral-300"
                style={{ width: `${pct}%` }}
              />
              {goalPct != null && (
                <div
                  className="absolute top-0 bottom-0 w-px bg-emerald-500"
                  style={{ left: `${goalPct}%` }}
                />
              )}
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
  props,
}: {
  data: ListShape
  onCellClick: ((raw: unknown) => void) | null
  props?: Record<string, unknown>
}) {
  if (!data.items?.length) {
    return <div className="p-4 text-[13px] text-neutral-400">(empty)</div>
  }
  const iconField = typeof props?.icon_slot === 'string' ? props.icon_slot : null
  const metaField = typeof props?.meta_slot === 'string' ? props.meta_slot : null
  const clickable = !!onCellClick
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {data.items.map((it, i) => {
        const raw = (it.raw ?? {}) as Record<string, unknown>
        const icon = iconField ? raw[iconField] : null
        const meta = metaField ? raw[metaField] : null
        return (
          <li
            key={i}
            onClick={clickable ? () => onCellClick!(it.raw) : undefined}
            className={
              'px-3 py-2 flex items-center gap-2 ' +
              (clickable ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50' : '')
            }
          >
            {icon != null && (
              <span className="w-5 h-5 flex items-center justify-center text-[14px] text-neutral-500 shrink-0">
                {String(icon)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-neutral-800 dark:text-neutral-100 truncate">
                {fmt(it.title)}
              </div>
              {meta != null && (
                <div className="text-[11.5px] text-neutral-500 truncate">{fmt(meta)}</div>
              )}
            </div>
            {it.value != null && (
              <span className="text-[12px] text-neutral-500 font-mono shrink-0">
                {fmt(it.value)}
              </span>
            )}
          </li>
        )
      })}
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

type ColumnFormat = 'money' | 'date' | 'datetime' | 'relative' | 'badge' | 'boolean' | 'percent'

function formatCell(v: unknown, kind: ColumnFormat | undefined): React.ReactNode {
  if (!kind) return fmt(v)
  if (v == null) return '—'
  switch (kind) {
    case 'money': {
      const n = Number(v)
      if (!Number.isFinite(n)) return fmt(v)
      return (
        <span className="font-mono">
          {Intl.NumberFormat(undefined, { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(n)}
        </span>
      )
    }
    case 'percent': {
      const n = Number(v)
      if (!Number.isFinite(n)) return fmt(v)
      const shown = Math.abs(n) <= 1 ? n * 100 : n
      return <span className="font-mono">{Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(shown)}%</span>
    }
    case 'date':
    case 'datetime': {
      const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v))
      if (Number.isNaN(d.getTime())) return fmt(v)
      return (
        <span className="font-mono text-neutral-600 dark:text-neutral-300">
          {kind === 'date' ? d.toLocaleDateString() : d.toLocaleString()}
        </span>
      )
    }
    case 'relative': {
      const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v))
      if (Number.isNaN(d.getTime())) return fmt(v)
      return <span className="font-mono text-neutral-600 dark:text-neutral-300">{formatTs(d.getTime())}</span>
    }
    case 'badge': {
      const s = String(v)
      return (
        <span className="inline-block px-1.5 py-[1px] rounded-sm bg-neutral-100 dark:bg-neutral-800 text-[12px] text-neutral-700 dark:text-neutral-200">
          {s}
        </span>
      )
    }
    case 'boolean': {
      const truthy = v === true || v === 1 || v === 'true' || v === 't'
      return (
        <span
          className={
            truthy
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-neutral-400'
          }
        >
          {truthy ? '✓' : '—'}
        </span>
      )
    }
    default:
      return fmt(v)
  }
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
