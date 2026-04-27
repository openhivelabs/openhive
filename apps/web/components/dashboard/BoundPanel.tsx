import type React from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, TrashSimple } from '@phosphor-icons/react'
import { clsx } from 'clsx'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { usePanelData } from '@/lib/hooks/usePanelData'
import type { CellAction, PanelAction, PanelSpec } from '@/lib/api/dashboards'
import { useLocaleTag, useT } from '@/lib/i18n'
import { actionLabel } from '@/lib/panels/actionLabel'
import { ActionFormModal, runConfirmAction } from './ActionForm'
import { MemoView } from './MemoView'

/** Renders a panel whose `binding` is set — data comes from the server's
 *  block cache (refreshed by the scheduler). The frontend is dumb: it trusts
 *  the mapper has already shaped the response to match the block's type.
 *
 *  A Cell is an interactive unit inside a panel (table row, kanban card, list
 *  item). When the binding declares `map.on_click`, Cells become clickable
 *  and trigger the action (detail modal, open URL, …). */
export function BoundPanel({ spec, teamId }: { spec: PanelSpec; teamId?: string }) {
  if (spec.type === 'memo') {
    return <MemoPanel panelId={spec.id} teamId={teamId} />
  }
  return <BoundPanelInner spec={spec} teamId={teamId} />
}

function MemoPanel({ panelId, teamId }: { panelId: string; teamId?: string }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <MemoView panelId={panelId} teamId={teamId} />
      </div>
    </div>
  )
}

function BoundPanelInner({ spec, teamId }: { spec: PanelSpec; teamId?: string }) {
  const t = useT()
  const { data, error, refresh } = usePanelData(spec.id, true)
  const onClick = spec.binding?.map?.on_click ?? null
  // Server-synthesized actions (kanban CRUD on bindings that don't carry
  // their own actions[]) ride the panel data response. Merge them with
  // the binding's actions so toolbar/row/inline partitioning, action
  // execution, and renderer wiring all see one unified list.
  const synthesizedActions = (() => {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const arr = (data as { synthesized_actions?: unknown }).synthesized_actions
      return Array.isArray(arr) ? (arr as PanelAction[]) : []
    }
    return []
  })()
  const persistedActions = spec.binding?.actions ?? []
  // Synthesized actions never override binding-declared ones with the
  // same id — the binding wins so a manual edit isn't silently swapped
  // out for a synthesized fallback on the next data refresh.
  const persistedIds = new Set(persistedActions.map((a) => a.id))
  // Table panels treat the synthesizer as authoritative for CRUD: small
  // binder models routinely produce broken INSERT/UPDATE for external
  // (mcp execute_sql) sources — wrong tenant column, mismatched quoting,
  // missing team_id. Drop persisted actions whose kind the synthesizer
  // already covers so the working synthesized version wins. Other panel
  // types (kanban) keep the legacy "persisted wins" behaviour.
  // Kanban + table panels treat the synthesizer as authoritative for CRUD
  // when the source is mcp execute_sql — small binder models routinely
  // produce broken INSERT/UPDATE for external sources (wrong placeholder
  // syntax, missing tenant column, mismatched quoting). The synthesizer
  // takes over so users get working drag/edit/delete without needing to
  // hand-edit SQL. team_data bindings keep persisted-wins behaviour.
  const isMcp = (spec.binding?.source as { kind?: unknown } | undefined)?.kind === 'mcp'
  const synthOverrides =
    spec.type === 'table' || (spec.type === 'kanban' && isMcp)
  const synthKinds = synthOverrides
    ? new Set(synthesizedActions.map((a) => a.kind))
    : new Set<string>()
  const actions: PanelAction[] = [
    ...persistedActions.filter((a) => !synthKinds.has(a.kind)),
    ...synthesizedActions.filter((a) => !persistedIds.has(a.id)),
  ]
  // Calendar / kanban / table all expose Add via a bottom-right "+" FAB
  // anchored to the body. Strip create-kind actions from the header
  // toolbar so the FAB doesn't duplicate as a "+ Add" button.
  const PANEL_TYPES_WITH_FAB = new Set(['calendar', 'table', 'kanban'])
  const explicitToolbar = actions.filter(
    (a) =>
      a.placement === 'toolbar' &&
      !(PANEL_TYPES_WITH_FAB.has(spec.type) && a.kind === 'create'),
  )
  const fallbackCreate =
    explicitToolbar.length === 0 && !PANEL_TYPES_WITH_FAB.has(spec.type)
      ? actions.find((a) => a.kind === 'create')
      : undefined
  const toolbarActions = fallbackCreate ? [fallbackCreate] : explicitToolbar
  // Table + kanban panels render a calendar-style "+" FAB. Surface the
  // create action separately so the body wrapper can render the FAB
  // without re-walking actions. (Calendar carries its own FAB inside
  // CalendarView, so we don't double up there.)
  const fabCreateAction =
    spec.type === 'table' || spec.type === 'kanban'
      ? actions.find((a) => a.kind === 'create')
      : undefined
  const rowActions = actions.filter((a) => a.placement === 'row')
  const inlineActions = actions.filter((a) => a.placement === 'inline')
  const [openAction, setOpenAction] = useState<PanelAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // After an action succeeds, force the panel hook to re-fetch + re-render
  // immediately. Without this the user has to wait up to POLL_MS for the
  // next polling tick to surface their newly created/updated/deleted row.
  const handleRefresh = async () => {
    try {
      await refresh()
    } catch {
      /* usePanelData surfaces error on next tick */
    }
  }

  const hasToolbar = !!(teamId && toolbarActions.length > 0)
  const header = hasToolbar ? (
    <div className="px-3 py-1.5 flex items-center gap-2 border-b border-neutral-100 dark:border-neutral-800">
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
            title={actionLabel(a, t)}
          >
            <Plus className="w-3 h-3" />
            <span>{actionLabel(a, t)}</span>
          </button>
        ))}
    </div>
  ) : null

  const body = (() => {
    if (data == null) {
      if (error) return null
      return null
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
          {errorCta(error, t)}
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
            {t('panel.actionDismiss')}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {body}
        {fabCreateAction && teamId && (
          <button
            type="button"
            onClick={() => {
              if (fabCreateAction.form?.fields?.length) setOpenAction(fabCreateAction)
              else
                runConfirmAction({
                  panelId: spec.id,
                  teamId,
                  action: fabCreateAction,
                  values: {},
                  t,
                  onSuccess: handleRefresh,
                  onError: setActionError,
                })
            }}
            title={actionLabel(fabCreateAction, t)}
            aria-label={actionLabel(fabCreateAction, t)}
            className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-md hover:bg-neutral-700 dark:hover:bg-neutral-300 flex items-center justify-center cursor-pointer z-10"
          >
            <Plus className="w-4 h-4" weight="bold" />
          </button>
        )}
      </div>
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

function errorCta(raw: string, t: (k: string) => string): React.ReactNode {
  const cred = raw.match(/missing credential:\s*"([^"]+)"/i)
  if (cred?.[1]) {
    const href = `/settings?section=credentials&prefill_ref=${encodeURIComponent(cred[1])}`
    return (
      <a
        href={href}
        className="shrink-0 text-neutral-600 dark:text-neutral-200 hover:underline"
      >
        {t('panel.errorCta.setup')}
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
        {t('panel.errorCta.install')}
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
            allActions={allActions ?? []}
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
      case 'stat_row':
        return <StatRowView data={data as MetricGridShape} />
      case 'calendar':
        return (
          <CalendarView
            data={data as CalendarShape}
            actions={allActions ?? []}
            panelId={panelId}
            teamId={teamId}
            onDone={onRowActionDone}
            onError={onRowActionError}
          />
        )
      case 'form':
        return (
          <FormView
            actions={allActions ?? []}
            panelId={panelId}
            teamId={teamId}
            onDone={onRowActionDone}
            onError={onRowActionError}
          />
        )
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
      {detail != null && (
        <DetailModal
          raw={detail}
          actions={allActions}
          panelId={panelId}
          teamId={teamId}
          onDone={() => {
            setDetail(null)
            onRowActionDone?.()
          }}
          onError={onRowActionError}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  )
}

// ---------- per-type renderers ----------------------------------------------

interface KpiShape {
  value: number | string | null
  rows_considered?: number
  /** Set when the binding's `delta_field` resolved a prior-period value.
   *  Renderer derives percent delta from (value - prior) / prior. Mapper
   *  emits the key as `null` (instead of omitting it) when configured but
   *  the row's value is NULL/missing — keeps the cached shape stable for
   *  the drift detector. */
  prior?: number | null
  /** Set when the binding's `target_field` resolved a goal target.
   *  Renderer draws a progress bar capped at 100%. Same null-as-stable
   *  treatment as `prior`. */
  target?: number | null
}
interface KpiProps {
  hint?: unknown
  /** Pre-computed delta from panel config (legacy). When `data.prior` is
   *  present it takes precedence — live data over static config. */
  delta?: { value?: number; direction?: 'up' | 'down' | 'flat'; percent?: boolean }
  sparkline?: number[]
  /** "currency" | "percent" | "number" | "duration" — controls the value
   *  formatter. Defaults to plain number with locale grouping. */
  format?: string
  /** Currency symbol when format=currency. Defaults to $. */
  currency?: string
  /** Free-form unit appended after the number — "명", "건", "m"… Used when
   *  the value isn't money/percent/duration but still needs a label. */
  suffix?: string
}
function KpiView({ data, props }: { data: KpiShape; props?: Record<string, unknown> }) {
  const t = useT()
  const p = (props ?? {}) as KpiProps
  // Default to compact (k/M) per the panel design — full numbers are
  // available behind a toggle for users who want every digit.
  const [unitMode, setUnitMode] = useState<'compact' | 'full'>('compact')
  const fmt = (n: number): string => formatKpi(n, p, unitMode)
  const display =
    typeof data.value === 'number' ? fmt(data.value) : String(data.value ?? '—')

  // Live data prior wins over the static prop. Compute %.
  const liveDelta = (() => {
    if (typeof data.value !== 'number' || typeof data.prior !== 'number') return null
    if (data.prior === 0) return null
    const pct = ((data.value - data.prior) / Math.abs(data.prior)) * 100
    const dir: 'up' | 'down' | 'flat' =
      Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down'
    return { pct, dir }
  })()
  const propDelta = p.delta
  const deltaColor = (dir: 'up' | 'down' | 'flat'): string =>
    dir === 'up'
      ? 'text-emerald-600 dark:text-emerald-400'
      : dir === 'down'
        ? 'text-red-600 dark:text-red-400'
        : 'text-neutral-500'
  const deltaArrow = (dir: 'up' | 'down' | 'flat'): string =>
    dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–'

  const spark = Array.isArray(p.sparkline) ? p.sparkline.filter((n) => Number.isFinite(n)) : []
  const showProgress =
    typeof data.value === 'number' && typeof data.target === 'number' && data.target > 0
  const pctOfTarget = showProgress
    ? Math.max(0, Math.min(100, ((data.value as number) / (data.target as number)) * 100))
    : 0

  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex justify-end items-center gap-1">
        <button
          type="button"
          onClick={() => setUnitMode('compact')}
          aria-pressed={unitMode === 'compact'}
          className={
            unitMode === 'compact'
              ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
              : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
          }
        >
          {t('kpi.unit.compact')}
        </button>
        <button
          type="button"
          onClick={() => setUnitMode('full')}
          aria-pressed={unitMode === 'full'}
          className={
            unitMode === 'full'
              ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
              : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
          }
        >
          {t('kpi.unit.full')}
        </button>
      </div>
      <div className="flex-1 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[32px] font-semibold text-neutral-900 dark:text-neutral-100 tracking-tight truncate">
            {display}
            {showProgress && (
              <span className="text-[14px] font-normal text-neutral-400 ml-1.5">
                / {fmt(data.target as number)}
              </span>
            )}
            {liveDelta ? (
              <span
                className={`text-[20px] font-medium font-mono ml-2 ${deltaColor(liveDelta.dir)}`}
              >
                ({liveDelta.dir === 'down' ? '-' : '+'}
                {Math.abs(liveDelta.pct).toFixed(0)}%)
              </span>
            ) : (
              propDelta &&
              typeof propDelta.value === 'number' && (
                <span
                  className={`text-[20px] font-medium font-mono ml-2 ${deltaColor(propDelta.direction ?? 'flat')}`}
                >
                  ({propDelta.direction === 'down' ? '-' : '+'}
                  {Intl.NumberFormat().format(Math.abs(propDelta.value))}
                  {propDelta.percent ? '%' : ''})
                </span>
              )
            )}
          </div>
          {showProgress && (
            <div className="mt-2">
              <div className="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                <div
                  className="h-full bg-neutral-800 dark:bg-neutral-200 rounded-full transition-all"
                  style={{ width: `${pctOfTarget}%` }}
                />
              </div>
              <div className="mt-1 text-[11px] font-mono text-neutral-500 tabular-nums">
                {pctOfTarget.toFixed(0)}%
              </div>
            </div>
          )}
        </div>
        {spark.length > 1 && <Sparkline values={spark} />}
      </div>
    </div>
  )
}

function formatKpi(
  n: number,
  p: { format?: string; currency?: string; suffix?: string },
  unitMode: 'compact' | 'full' = 'compact',
): string {
  const f = (p.format ?? '').toLowerCase()
  if (f === 'percent') return `${(n * 100).toFixed(1)}%`
  if (f === 'duration') {
    if (n < 60) return `${n.toFixed(0)}s`
    if (n < 3600) return `${(n / 60).toFixed(0)}m`
    if (n < 86_400) return `${(n / 3600).toFixed(1)}h`
    return `${(n / 86_400).toFixed(1)}d`
  }
  const prefix = f === 'currency' ? (p.currency ?? '$') : ''
  const suffix = p.suffix ? p.suffix : ''
  const body =
    unitMode === 'full'
      ? Intl.NumberFormat().format(Math.round(n))
      : compactNumber(n)
  return `${prefix}${body}${suffix}`
}

/** SI-style compact: 1.2k / 3.4M / 1.5B / 2.1T. Sub-thousand passes through
 *  with locale grouping so "857" doesn't collapse into "0.9k". */
function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return Intl.NumberFormat().format(Math.round(n))
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

/** Single horizontal row of compact stats. Same data shape as
 *  metric_grid (cells[]) — different layout: one slim row with vertical
 *  dividers, label-on-top + medium-sized number. Best for 3-6 sibling
 *  counters that should be scanned together (queue states, deploy stats,
 *  active/pending/done summaries). */
function StatRowView({ data }: { data: MetricGridShape }) {
  const t = useT()
  const [unitMode, setUnitMode] = useState<'compact' | 'full'>('compact')
  const cells = Array.isArray(data?.cells) ? data.cells : []
  if (cells.length === 0) {
    return <div className="p-4 text-[13px] text-neutral-400">{t('chart.noData')}</div>
  }
  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-end items-center gap-1 px-3 pt-2">
        <button
          type="button"
          onClick={() => setUnitMode('compact')}
          aria-pressed={unitMode === 'compact'}
          className={
            unitMode === 'compact'
              ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
              : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
          }
        >
          {t('kpi.unit.compact')}
        </button>
        <button
          type="button"
          onClick={() => setUnitMode('full')}
          aria-pressed={unitMode === 'full'}
          className={
            unitMode === 'full'
              ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
              : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
          }
        >
          {t('kpi.unit.full')}
        </button>
      </div>
      <div className="flex-1 flex items-center px-2">
        <div className="flex w-full divide-x divide-neutral-200 dark:divide-neutral-800">
          {cells.map((c, i) => {
            const display =
              typeof c.value === 'number'
                ? unitMode === 'compact'
                  ? compactNumber(c.value)
                  : Intl.NumberFormat().format(c.value)
                : String(c.value ?? '—')
            return (
              <div key={i} className="flex-1 px-4 py-3 min-w-0">
                <div className="text-[11.5px] text-neutral-500 uppercase tracking-wider font-medium truncate">
                  {c.label}
                </div>
                <div className="mt-1.5 text-[28px] font-semibold tracking-tight tabular-nums truncate">
                  {display}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Data-entry panel — renders the panel's first `create` action as an
 *  inline form. Required fields show a red `*`. Submit calls the existing
 *  panel-action endpoint, which goes through the validated INSERT path
 *  (separate from the read-only refresh/preview path that bindings use).
 *  Use it for "log a row" workflows: add task, log expense, file ticket. */
interface CalendarEvent {
  id: unknown
  date: string | null
  time: string | null
  endDate: string | null
  endTime: string | null
  title: unknown
  kind: unknown
  raw: unknown
}

interface CalendarShape {
  events: CalendarEvent[]
  /** Column names backing start / end timestamps in the source table. The
   *  renderer needs these so drag-to-reschedule can write to the correct
   *  columns and the form can label its From / To fields. `end` is null
   *  when the binding doesn't map a separate end column. */
  fields?: { start: string; end: string | null }
}

const DEFAULT_DURATION_MIN = 60

/** Stable color from a `kind` string. We pick from a small palette by hashing
 *  the lowercased value — same kind always maps to the same color across
 *  refreshes / users. Null / empty → neutral. Tailwind class fragments
 *  (chip bg/text + accent border) so the same hash drives both surfaces. */
/** Each kind gets:
 *   - `chip`   solid pastel for chips/labels (catalog tile, kind tag)
 *   - `border` left-edge accent stripe used on cards
 *   - `fill`   semi-transparent fill used ONLY on timed-event cards in the
 *              rail. Combined with `mix-blend-multiply` (light) /
 *              `mix-blend-screen` (dark) on the card so overlapping events
 *              composite into a blended color in the overlap region — the
 *              user's "two events on top of each other show their mix"
 *              request. */
const KIND_PALETTE = [
  { chip: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200', border: 'border-l-amber-400', fill: 'bg-amber-300/60 dark:bg-amber-400/40' },
  { chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',   border: 'border-l-blue-400',  fill: 'bg-blue-300/60 dark:bg-blue-400/40' },
  { chip: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200', border: 'border-l-violet-400', fill: 'bg-violet-300/60 dark:bg-violet-400/40' },
  { chip: 'bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200',   border: 'border-l-lime-400',  fill: 'bg-lime-300/60 dark:bg-lime-400/40' },
  { chip: 'bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-200',   border: 'border-l-pink-400',  fill: 'bg-pink-300/60 dark:bg-pink-400/40' },
  { chip: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-200',   border: 'border-l-cyan-400',  fill: 'bg-cyan-300/60 dark:bg-cyan-400/40' },
] as const
const KIND_NEUTRAL = {
  chip: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
  border: 'border-l-neutral-300 dark:border-l-neutral-600',
  fill: 'bg-neutral-300/50 dark:bg-neutral-500/40',
} as const

function kindColor(kind: unknown): { chip: string; border: string; fill: string } {
  if (kind == null) return KIND_NEUTRAL
  const s = String(kind).trim().toLowerCase()
  if (!s) return KIND_NEUTRAL
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return KIND_PALETTE[(h >>> 0) % KIND_PALETTE.length] ?? KIND_NEUTRAL
}

const HIDDEN_RAW_KEYS = new Set(['id', 'team_id', 'created_at', 'updated_at'])

/** Calendar detail-modal field order. Anything not listed stays in source
 *  order, but `note` always sinks to right after `status`. */
function orderEventFields<T>(entries: [string, T][]): [string, T][] {
  const noteIdx = entries.findIndex(([k]) => k === 'note')
  if (noteIdx === -1) return entries
  const statusIdx = entries.findIndex(([k]) => k === 'status')
  if (statusIdx === -1) return entries
  const out = entries.slice()
  const [note] = out.splice(noteIdx, 1)
  if (!note) return entries
  const insertAt = noteIdx < statusIdx ? statusIdx : statusIdx + 1
  out.splice(insertAt, 0, note)
  return out
}

/** Older calendar installs declared the date column with `type: date`
 *  (date-only, no time picker). The new calendar UX needs a time of day,
 *  so transparently promote any `date` field to `datetime-local` whenever
 *  it's used inside the calendar panel. Stored date-only strings get a
 *  midnight time appended so the datetime-local input renders them. */
function promoteDateFields(
  fields: NonNullable<NonNullable<PanelAction['form']>['fields']>,
): NonNullable<NonNullable<PanelAction['form']>['fields']> {
  return fields.map((f) => (f.type === 'date' ? { ...f, type: 'datetime-local' } : f))
}
function normalizeDateValue(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  // bare YYYY-MM-DD → append midnight so the datetime picker isn't empty
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`
  return s
}

/** Interactive month calendar: left grid (clickable day cells with kind-
 *  colored event chips) + right detail pane. Selecting a date populates the
 *  pane with that day's events as expandable cards — collapsed shows time +
 *  title + kind chip; expanded shows every column from the source row plus
 *  inline Edit / Delete buttons. The "+ Add" form at the bottom auto-fills
 *  the date column with the selected day. All three CRUD actions go through
 *  the same panel-action endpoint as form panels. */
function CalendarView({
  data,
  actions,
  panelId,
  teamId,
  onDone,
  onError,
}: {
  data: CalendarShape
  actions: PanelAction[]
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
}) {
  const t = useT()
  const localeTag = useLocaleTag()
  const events = Array.isArray(data?.events) ? data.events : []
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])
  const [cursor, setCursor] = useState<Date>(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  )
  const [selectedDate, setSelectedDate] = useState<string>(() => fmtKey(today))
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addingNew, setAddingNew] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState<'create' | 'update' | 'delete' | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const createAction = actions.find((a) => a.kind === 'create')
  const updateAction = actions.find((a) => a.kind === 'update')
  const deleteAction = actions.find((a) => a.kind === 'delete')

  const eventsByDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      if (!e.date) continue
      const list = m.get(e.date) ?? []
      list.push(e)
      m.set(e.date, list)
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time)
        if (a.time) return -1
        if (b.time) return 1
        return 0
      })
    }
    return m
  }, [events])

  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const monthLabel = cursor.toLocaleDateString(localeTag, { year: 'numeric', month: 'long' })
  const firstOfMonth = new Date(year, month, 1)
  const dayOfWeekMonStart = (firstOfMonth.getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - dayOfWeekMonStart)
  const cells: Date[] = []
  for (let i = 0; i < 42; i += 1) {
    cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  }
  const dayHeaders = [
    t('calendar.dow.mon'),
    t('calendar.dow.tue'),
    t('calendar.dow.wed'),
    t('calendar.dow.thu'),
    t('calendar.dow.fri'),
    t('calendar.dow.sat'),
    t('calendar.dow.sun'),
  ]

  const dayEvents = eventsByDate.get(selectedDate) ?? []
  const dayLabel = new Date(`${selectedDate}T00:00:00`).toLocaleDateString(localeTag, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  })

  const closeAllForms = () => {
    setEditingId(null)
    setAddingNew(false)
    setExpandedId(null)
    setConfirmDeleteId(null)
    setValues({})
    setFeedback(null)
  }

  const selectDate = (key: string) => {
    setSelectedDate(key)
    closeAllForms()
  }

  const openEvent = (e: CalendarEvent, key: string) => {
    setSelectedDate(key)
    const idStr = e.id == null ? null : String(e.id)
    setExpandedId(idStr)
    setEditingId(null)
    setAddingNew(false)
    setConfirmDeleteId(null)
    setValues({})
    setFeedback(null)
  }

  const startEdit = (e: CalendarEvent) => {
    const idStr = e.id == null ? null : String(e.id)
    if (idStr == null || !updateAction) return
    const prefill: Record<string, unknown> = {}
    if (e.raw && typeof e.raw === 'object') {
      for (const f of promoteDateFields(updateAction.form?.fields ?? [])) {
        const raw = (e.raw as Record<string, unknown>)[f.name] ?? ''
        prefill[f.name] = f.type === 'datetime-local' ? normalizeDateValue(raw) : raw
      }
    }
    setEditingId(idStr)
    setExpandedId(idStr)
    setAddingNew(false)
    setValues(prefill)
    setFeedback(null)
  }

  const startAdd = (hour?: number) => {
    if (!createAction) return
    const prefill: Record<string, unknown> = {}
    const startH = hour != null && Number.isFinite(hour)
      ? Math.max(0, Math.min(23, Math.floor(hour)))
      : 9
    const startStr = `${selectedDate}T${String(startH).padStart(2, '0')}:00`
    const endStr = `${selectedDate}T${String(Math.min(23, startH + 1)).padStart(2, '0')}:00`
    const startName = data?.fields?.start ?? null
    const endName = data?.fields?.end ?? null
    for (const f of promoteDateFields(createAction.form?.fields ?? [])) {
      if (f.type === 'datetime' || f.type === 'datetime-local') {
        // If we know which field is end, prefill it with start + 1 hour;
        // otherwise default everything to start.
        prefill[f.name] = endName && f.name === endName ? endStr : startStr
      } else if (f.type === 'time') prefill[f.name] = `${String(startH).padStart(2, '0')}:00`
      else if (f.default != null) prefill[f.name] = f.default
    }
    void startName // explicit acknowledgement that startName isn't strictly needed in prefill (datetime fields default to startStr)
    setAddingNew(true)
    setEditingId(null)
    setExpandedId(null)
    setConfirmDeleteId(null)
    setValues(prefill)
    setFeedback(null)
  }

  const submit = async () => {
    if (!panelId || !teamId) return
    const action = editingId != null ? updateAction : createAction
    if (!action) return
    setBusy(editingId != null ? 'update' : 'create')
    setFeedback(null)
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const payload: Record<string, unknown> = { ...values }
      if (editingId != null) payload.id = editingId
      const r = await executePanelAction(panelId, action.id, teamId, payload)
      if (r.ok) {
        setFeedback({ kind: 'ok', text: '✓' })
        closeAllForms()
        onDone?.()
      } else {
        const msg = r.detail ?? 'failed'
        setFeedback({ kind: 'err', text: msg })
        onError?.(msg)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFeedback({ kind: 'err', text: msg })
      onError?.(msg)
    } finally {
      setBusy(null)
    }
  }

  /** Drag-and-drop reschedule: rewrite the event's start (and end, if the
   *  binding maps one) timestamp on the same date, snapped to the dragged
   *  time. Duration is preserved so a 90-min event stays 90 min after the
   *  drop. We piggyback on the update action so the row write runs through
   *  the same validated path as Edit-form Save. */
  const rescheduleEvent = async (e: CalendarEvent, newHHMM: string) => {
    if (!panelId || !teamId || !updateAction) return
    const idStr = e.id == null ? null : String(e.id)
    if (idStr == null) return
    const promoted = promoteDateFields(updateAction.form?.fields ?? [])
    // Identify start / end columns: prefer mapper-provided field names so
    // we don't guess wrong when the form has multiple datetime fields.
    const startName = data?.fields?.start ?? null
    const endName = data?.fields?.end ?? null
    const startField =
      (startName && promoted.find((f) => f.name === startName)) ||
      promoted.find((f) => f.type === 'datetime' || f.type === 'datetime-local')
    if (!startField) return
    const endField = endName ? promoted.find((f) => f.name === endName) : null

    const payload: Record<string, unknown> = { id: idStr }
    if (e.raw && typeof e.raw === 'object') {
      for (const f of promoted) {
        payload[f.name] = (e.raw as Record<string, unknown>)[f.name] ?? ''
      }
    }
    payload[startField.name] = `${selectedDate}T${newHHMM}`
    if (endField && e.time) {
      // Preserve duration: shift end by the same delta as start.
      const [oh, om] = e.time.split(':')
      const oldStartMin = parseInt(oh ?? '0', 10) * 60 + parseInt(om ?? '0', 10)
      const [nh, nm] = newHHMM.split(':')
      const newStartMin = parseInt(nh ?? '0', 10) * 60 + parseInt(nm ?? '0', 10)
      const delta = newStartMin - oldStartMin
      const oldEndMin = e.endTime
        ? parseInt(e.endTime.split(':')[0] ?? '0', 10) * 60 +
          parseInt(e.endTime.split(':')[1] ?? '0', 10)
        : oldStartMin + DEFAULT_DURATION_MIN
      const newEndMin = Math.max(0, Math.min(24 * 60 - 1, oldEndMin + delta))
      const eh = String(Math.floor(newEndMin / 60)).padStart(2, '0')
      const em = String(newEndMin % 60).padStart(2, '0')
      payload[endField.name] = `${selectedDate}T${eh}:${em}`
    }
    setBusy('update')
    setFeedback(null)
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const r = await executePanelAction(panelId, updateAction.id, teamId, payload)
      if (r.ok) {
        setFeedback({ kind: 'ok', text: '✓' })
        onDone?.()
      } else {
        const msg = r.detail ?? 'failed'
        setFeedback({ kind: 'err', text: msg })
        onError?.(msg)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setFeedback({ kind: 'err', text: msg })
      onError?.(msg)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (id: string) => {
    if (!panelId || !teamId || !deleteAction) return
    setBusy('delete')
    setFeedback(null)
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const r = await executePanelAction(panelId, deleteAction.id, teamId, { id })
      if (r.ok) {
        setFeedback({ kind: 'ok', text: '✓' })
        closeAllForms()
        onDone?.()
      } else {
        const msg = r.detail ?? 'failed'
        setFeedback({ kind: 'err', text: msg })
        onError?.(msg)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFeedback({ kind: 'err', text: msg })
      onError?.(msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full flex">
      {/* Left: month grid */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="shrink-0 flex items-center justify-between px-3 py-2">
          <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
            {monthLabel}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month - 1, 1))}
              className="px-2 py-0.5 rounded-sm text-[12px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => {
                setCursor(new Date(today.getFullYear(), today.getMonth(), 1))
                selectDate(fmtKey(today))
              }}
              className="px-2 py-0.5 rounded-sm text-[11px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
            >
              {t('calendar.today')}
            </button>
            <button
              type="button"
              onClick={() => setCursor(new Date(year, month + 1, 1))}
              className="px-2 py-0.5 rounded-sm text-[12px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer"
            >
              ›
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-3 pb-3">
          <div className="grid grid-cols-7 gap-px bg-neutral-200 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-sm overflow-hidden">
            {dayHeaders.map((h) => (
              <div
                key={h}
                className="bg-neutral-50 dark:bg-neutral-900 px-1.5 py-1 text-[10.5px] uppercase tracking-wider text-neutral-500 text-center"
              >
                {h}
              </div>
            ))}
            {cells.map((d) => {
              const inMonth = d.getMonth() === month
              const isToday = isSameDayDate(d, today)
              const key = fmtKey(d)
              const isSelected = key === selectedDate
              const cellEvents = eventsByDate.get(key) ?? []
              const shown = cellEvents.slice(0, 2)
              const more = cellEvents.length - shown.length
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectDate(key)}
                  className={
                    isSelected
                      ? 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-50 ring-1 ring-inset ring-neutral-400 dark:ring-neutral-500 px-1 py-1 min-h-[68px] flex flex-col gap-0.5 text-left cursor-pointer'
                      : isToday
                        ? 'bg-neutral-100 dark:bg-neutral-800 px-1 py-1 min-h-[68px] flex flex-col gap-0.5 text-left cursor-pointer hover:bg-neutral-200 dark:hover:bg-neutral-700'
                        : 'bg-white dark:bg-neutral-900 px-1 py-1 min-h-[68px] flex flex-col gap-0.5 text-left cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800'
                  }
                >
                  <div
                    className={
                      isSelected
                        ? 'text-[11px] font-semibold text-neutral-900 dark:text-neutral-50 tabular-nums px-0.5'
                        : inMonth
                          ? isToday
                            ? 'text-[11px] font-semibold text-neutral-900 dark:text-neutral-50 tabular-nums px-0.5'
                            : 'text-[11px] text-neutral-700 dark:text-neutral-300 tabular-nums px-0.5'
                          : 'text-[11px] text-neutral-300 dark:text-neutral-600 tabular-nums px-0.5'
                    }
                  >
                    {d.getDate()}
                  </div>
                  {shown.map((e, i) => {
                    const c = kindColor(e.kind)
                    return (
                      <span
                        key={i}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          selectDate(key)
                        }}
                        title={String(e.title ?? '')}
                        className={`text-[9.5px] truncate rounded-[2px] px-1 py-px ${c.chip}`}
                      >
                        {e.time ? `${e.time} ` : ''}{String(e.title ?? '·')}
                      </span>
                    )
                  })}
                  {more > 0 && (
                    <div
                      className="text-[9.5px] text-neutral-400 px-0.5"
                    >
                      {t('calendar.more', { n: String(more) })}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Right: day timetable */}
      <CalendarDayPane
        dayLabel={dayLabel}
        dayEvents={dayEvents}
        selectedDate={selectedDate}
        startFieldName={data?.fields?.start ?? null}
        endFieldName={data?.fields?.end ?? null}
        feedback={feedback}
        expandedId={expandedId}
        editingId={editingId}
        addingNew={addingNew}
        confirmDeleteId={confirmDeleteId}
        values={values}
        busy={busy}
        createAction={createAction}
        updateAction={updateAction}
        deleteAction={deleteAction}
        onOpenEvent={(e) => openEvent(e, selectedDate)}
        onClose={closeAllForms}
        onStartEdit={startEdit}
        onStartAdd={startAdd}
        onSetValues={setValues}
        onSubmit={submit}
        onRemove={remove}
        onConfirmDelete={setConfirmDeleteId}
        onReschedule={rescheduleEvent}
      />
    </div>
  )
}

/** Right-side day timetable: vertical 24-hour rail. Events with a time of
 *  day are absolutely positioned at their hour row and can be dragged to
 *  reschedule (snapped to 15-min increments). Events without a time of day
 *  go into the "All-day" strip up top. The overlay at the bottom hosts the
 *  expanded detail / edit / add forms so the timetable stays visible. The
 *  "+" FAB at the bottom-right opens an Add form prefilled with the date
 *  + a sensible hour (9 AM by default; the hour clicked when you click an
 *  empty slot in the rail). */
const HOUR_HEIGHT = 44
const DRAG_SNAP_MIN = 15
/** A pointerdown only becomes a drag once it crosses this many pixels;
 *  anything less is treated as a click (open detail overlay). */
const CLICK_THRESHOLD_PX = 4

function CalendarDayPane({
  dayLabel,
  dayEvents,
  selectedDate,
  startFieldName,
  endFieldName,
  feedback,
  expandedId,
  editingId,
  addingNew,
  confirmDeleteId,
  values,
  busy,
  createAction,
  updateAction,
  deleteAction,
  onOpenEvent,
  onClose,
  onStartEdit,
  onStartAdd,
  onSetValues,
  onSubmit,
  onRemove,
  onConfirmDelete,
  onReschedule,
}: {
  dayLabel: string
  dayEvents: CalendarEvent[]
  selectedDate: string
  startFieldName: string | null
  endFieldName: string | null
  feedback: { kind: 'ok' | 'err'; text: string } | null
  expandedId: string | null
  editingId: string | null
  addingNew: boolean
  confirmDeleteId: string | null
  values: Record<string, unknown>
  busy: 'create' | 'update' | 'delete' | null
  createAction?: PanelAction
  updateAction?: PanelAction
  deleteAction?: PanelAction
  onOpenEvent: (e: CalendarEvent) => void
  onClose: () => void
  onStartEdit: (e: CalendarEvent) => void
  onStartAdd: (hour?: number) => void
  onSetValues: (v: Record<string, unknown>) => void
  onSubmit: () => void
  onRemove: (id: string) => void
  onConfirmDelete: (id: string | null) => void
  onReschedule: (e: CalendarEvent, newHHMM: string) => void
}) {
  const t = useT()
  const railRef = useRef<HTMLDivElement | null>(null)
  // Two states track pointer interaction so a click on a card opens the
  // detail overlay while a drag past the threshold reschedules the event.
  // `pressRef` records the initial press; the window-level pointermove
  // promotes it to `drag` only after movement > CLICK_THRESHOLD_PX.
  const pressRef = useRef<
    | { event: CalendarEvent; id: string; x: number; y: number; moved: boolean }
    | null
  >(null)
  const [drag, setDrag] = useState<{
    id: string
    event: CalendarEvent
    minutes: number // current start-minutes-from-midnight while dragging
  } | null>(null)
  // Stash callbacks in refs so the window-level pointer listeners (mounted
  // once) always see the freshest functions without re-binding on every
  // change.
  const onOpenEventRef = useRef(onOpenEvent)
  const onRescheduleRef = useRef(onReschedule)
  onOpenEventRef.current = onOpenEvent
  onRescheduleRef.current = onReschedule

  const allDayEvents = dayEvents.filter((e) => !e.time)
  const timedEvents = dayEvents.filter((e) => !!e.time)
  const expandedEvent = expandedId
    ? dayEvents.find((e) => e.id != null && String(e.id) === expandedId) ?? null
    : null
  const showOverlay = !!(expandedEvent || addingNew)

  // Auto-scroll the rail to a sensible starting hour: first timed event,
  // or 8 AM. Only on day change so user-scroll inside a day isn't undone.
  useEffect(() => {
    if (!railRef.current) return
    const firstHour = timedEvents.length > 0
      ? Math.max(0, parseInt(timedEvents[0]!.time!.slice(0, 2), 10) - 1)
      : 8
    railRef.current.scrollTop = firstHour * HOUR_HEIGHT
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate])

  // Window-level pointer listeners mounted once for the lifetime of the
  // pane. They read pressRef + the latest callback refs so we don't have to
  // tear them down on every state change.
  useEffect(() => {
    const move = (ev: PointerEvent) => {
      const press = pressRef.current
      if (!press) return
      const dx = ev.clientX - press.x
      const dy = ev.clientY - press.y
      if (!press.moved && Math.hypot(dx, dy) < CLICK_THRESHOLD_PX) return
      press.moved = true
      const rail = railRef.current
      if (!rail) return
      const rect = rail.getBoundingClientRect()
      const y = ev.clientY - rect.top + rail.scrollTop
      const rawMin = (y / HOUR_HEIGHT) * 60
      const snapped = Math.round(rawMin / DRAG_SNAP_MIN) * DRAG_SNAP_MIN
      const minutes = Math.max(0, Math.min(24 * 60 - DRAG_SNAP_MIN, snapped))
      setDrag({ event: press.event, id: press.id, minutes })
    }
    const up = () => {
      const press = pressRef.current
      pressRef.current = null
      if (press && !press.moved) {
        // Click — no drag → open detail overlay
        onOpenEventRef.current(press.event)
        setDrag(null)
        return
      }
      setDrag((d) => {
        if (d) {
          const hh = String(Math.floor(d.minutes / 60)).padStart(2, '0')
          const mm = String(d.minutes % 60).padStart(2, '0')
          const newHHMM = `${hh}:${mm}`
          if (d.event.time !== newHHMM) onRescheduleRef.current(d.event, newHHMM)
        }
        return null
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  const startPress = (ev: React.PointerEvent, e: CalendarEvent) => {
    const idStr = e.id == null ? null : String(e.id)
    if (idStr == null || !e.time) return
    ev.preventDefault()
    ev.stopPropagation()
    pressRef.current = {
      event: e,
      id: idStr,
      x: ev.clientX,
      y: ev.clientY,
      moved: false,
    }
  }

  /** Compute event duration in minutes — if the event has its own end time
   *  use that; otherwise fall back to the 1-hour default. Used both for
   *  card height and for drawing the drag ghost at the right size. */
  const durationMinFor = (e: CalendarEvent): number => {
    if (e.time && e.endTime) {
      const [sh, sm] = e.time.split(':')
      const [eh, em] = e.endTime.split(':')
      const start = parseInt(sh ?? '0', 10) * 60 + parseInt(sm ?? '0', 10)
      const end = parseInt(eh ?? '0', 10) * 60 + parseInt(em ?? '0', 10)
      const diff = end - start
      if (diff > 0) return diff
    }
    return DEFAULT_DURATION_MIN
  }

  return (
    <div className="w-[360px] shrink-0 flex flex-col relative">
      <div className="shrink-0 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
        <div className="text-[12.5px] font-medium text-neutral-700 dark:text-neutral-200 truncate">
          {dayLabel}
        </div>
        {feedback && (
          <span
            className={
              feedback.kind === 'ok'
                ? 'text-[11px] text-emerald-600 dark:text-emerald-400'
                : 'text-[11px] text-red-600 dark:text-red-400 font-mono truncate max-w-[140px]'
            }
            title={feedback.text}
          >
            {feedback.text}
          </span>
        )}
      </div>

      {/* All-day strip */}
      {allDayEvents.length > 0 && (
        <div className="shrink-0 px-2 py-1.5 border-b border-neutral-200 dark:border-neutral-800 flex flex-col gap-1 max-h-[80px] overflow-auto">
          <div className="text-[10px] uppercase tracking-wider text-neutral-400">
            {t('calendar.allDay')}
          </div>
          {allDayEvents.map((e) => {
            const idStr = e.id == null ? null : String(e.id)
            const c = kindColor(e.kind)
            return (
              <button
                key={idStr ?? Math.random()}
                type="button"
                onClick={() => idStr != null && onOpenEvent(e)}
                className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm text-left text-[11.5px] truncate cursor-pointer border-l-2 ${c.border} bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800`}
              >
                <span className="truncate">{String(e.title ?? '')}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Hour rail */}
      <div ref={railRef} className="flex-1 min-h-0 overflow-auto">
        <div className="relative" style={{ height: 24 * HOUR_HEIGHT }}>
          {Array.from({ length: 24 }).map((_, h) => (
            <button
              key={h}
              type="button"
              onClick={() => createAction && onStartAdd(h)}
              className="absolute left-0 right-0 flex border-t border-neutral-100 dark:border-neutral-800 text-left cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
              style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }}
              title={createAction ? t('calendar.add') : undefined}
            >
              <span className="w-10 shrink-0 pt-0.5 pr-1 text-right text-[10px] font-mono tabular-nums text-neutral-400">
                {String(h).padStart(2, '0')}
              </span>
              <span className="flex-1" />
            </button>
          ))}

          {/* Drag ghost (preview) */}
          {drag && (() => {
            const dur = durationMinFor(drag.event)
            const endMin = drag.minutes + dur
            const eh = String(Math.floor(endMin / 60) % 24).padStart(2, '0')
            const em = String(endMin % 60).padStart(2, '0')
            const sh = String(Math.floor(drag.minutes / 60)).padStart(2, '0')
            const sm = String(drag.minutes % 60).padStart(2, '0')
            return (
              <div
                className="absolute left-10 right-2 rounded-sm border border-dashed border-neutral-400 bg-neutral-100/70 dark:bg-neutral-800/70 px-1.5 py-1 text-[11px] text-neutral-700 dark:text-neutral-200 pointer-events-none"
                style={{
                  top: (drag.minutes / 60) * HOUR_HEIGHT,
                  height: Math.max(HOUR_HEIGHT - 2, (dur / 60) * HOUR_HEIGHT - 2),
                }}
              >
                <span className="font-mono tabular-nums text-neutral-500 mr-1">
                  {sh}:{sm}–{eh}:{em}
                </span>
                {String(drag.event.title ?? '')}
              </div>
            )
          })()}

          {/* Timed events */}
          {timedEvents.map((e) => {
            const idStr = e.id == null ? null : String(e.id)
            if (idStr == null || !e.time) return null
            const isDragging = drag?.id === idStr
            if (isDragging) return null
            const [hh, mm] = e.time.split(':')
            const startMin = parseInt(hh ?? '0', 10) * 60 + parseInt(mm ?? '0', 10)
            const top = (startMin / 60) * HOUR_HEIGHT
            const dur = durationMinFor(e)
            const height = Math.max(HOUR_HEIGHT - 2, (dur / 60) * HOUR_HEIGHT - 2)
            const c = kindColor(e.kind)
            const isExpanded = expandedId === idStr
            const rangeLabel = e.endTime ? `${e.time}–${e.endTime}` : e.time
            return (
              <div
                key={idStr}
                onPointerDown={(ev) => startPress(ev, e)}
                className={`absolute left-10 right-2 rounded-sm border border-l-4 ${c.border} border-y-neutral-200 border-r-neutral-200 dark:border-y-neutral-800 dark:border-r-neutral-800 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100 px-1.5 py-1 text-[11.5px] cursor-grab active:cursor-grabbing overflow-hidden ${
                  isExpanded ? 'ring-2 ring-neutral-400 dark:ring-neutral-500' : ''
                }`}
                style={{ top, height }}
                title={String(e.title ?? '')}
              >
                <div className="font-mono tabular-nums opacity-70 text-[10px]">{rangeLabel}</div>
                <div className="truncate">{String(e.title ?? '')}</div>
              </div>
            )
          })}
        </div>
      </div>

      {/* + FAB */}
      {createAction && !showOverlay && (
        <button
          type="button"
          onClick={() => onStartAdd()}
          title={t('calendar.add')}
          className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 shadow-md hover:bg-neutral-700 dark:hover:bg-neutral-300 flex items-center justify-center cursor-pointer"
          aria-label={t('calendar.add')}
        >
          <Plus className="w-4 h-4" weight="bold" />
        </button>
      )}

      {/* Modal: detail / edit / add */}
      {showOverlay && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={onClose}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
        >
          <div
            className="w-[420px] max-w-[92vw] max-h-[80vh] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-md shadow-xl overflow-auto"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="document"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-100 dark:border-neutral-800">
              <div className="text-[12.5px] font-medium text-neutral-700 dark:text-neutral-200 truncate">
                {addingNew ? t('calendar.add') : editingId ? t('calendar.edit') : String(expandedEvent?.title ?? '')}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-[14px] leading-none text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer w-6 h-6 flex items-center justify-center rounded-sm"
                aria-label={t('calendar.cancel')}
              >
                ×
              </button>
            </div>
            <div className="p-3">
            {addingNew && createAction && (
              <CalendarEventForm
                fields={promoteDateFields(createAction.form?.fields ?? [])}
                values={values}
                onChange={onSetValues}
                onSubmit={onSubmit}
                onCancel={onClose}
                busy={busy === 'create'}
                submitLabel={t('calendar.add')}
                startFieldName={startFieldName}
                endFieldName={endFieldName}
              />
            )}
            {!addingNew && expandedEvent && editingId && updateAction && (
              <CalendarEventForm
                fields={promoteDateFields(updateAction.form?.fields ?? [])}
                values={values}
                onChange={onSetValues}
                onSubmit={onSubmit}
                onCancel={onClose}
                busy={busy === 'update'}
                submitLabel={t('calendar.save')}
                startFieldName={startFieldName}
                endFieldName={endFieldName}
              />
            )}
            {!addingNew && expandedEvent && !editingId && (
              <>
                {expandedEvent.raw && typeof expandedEvent.raw === 'object' ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[12px]">
                    {orderEventFields(
                      Object.entries(expandedEvent.raw as Record<string, unknown>).filter(
                        ([k]) => !HIDDEN_RAW_KEYS.has(k),
                      ),
                    ).map(([k, v]) => (
                      <Fragment key={k}>
                        <dt className="text-neutral-400 truncate">{k}</dt>
                        <dd className="text-neutral-700 dark:text-neutral-200 break-all">
                          {v == null || v === '' ? '—' : String(v)}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : null}
                <div className="flex items-center gap-2 mt-3">
                  {updateAction && (
                    <button
                      type="button"
                      onClick={() => onStartEdit(expandedEvent)}
                      className="h-7 px-3 text-[12px] rounded-sm text-neutral-700 dark:text-neutral-200 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 cursor-pointer"
                    >
                      {t('calendar.edit')}
                    </button>
                  )}
                  {deleteAction && expandedId && (
                    <button
                      type="button"
                      onClick={() => {
                        if (confirmDeleteId === expandedId) onRemove(expandedId)
                        else onConfirmDelete(expandedId)
                      }}
                      disabled={busy != null}
                      className={
                        confirmDeleteId === expandedId
                          ? 'h-7 px-3 text-[12px] rounded-sm text-white bg-red-600 hover:bg-red-700 cursor-pointer disabled:opacity-40'
                          : 'h-7 px-3 text-[12px] rounded-sm text-neutral-600 dark:text-neutral-300 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer disabled:opacity-40'
                      }
                    >
                      {confirmDeleteId === expandedId ? t('calendar.confirmDelete') : t('calendar.delete')}
                    </button>
                  )}
                  {confirmDeleteId === expandedId && (
                    <button
                      type="button"
                      onClick={() => onConfirmDelete(null)}
                      className="h-7 px-2 text-[12px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer"
                    >
                      {t('calendar.cancel')}
                    </button>
                  )}
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Calendar-specific event form. Unlike the generic CalendarForm it
 *  RESHAPES the start/end datetime fields from the binding into three
 *  separate inputs: a single Date picker + From / To time pickers. The
 *  underlying datetime-local values still get written back into the form
 *  state so the action SQL bindings keep working unchanged.
 *
 *  The user feedback was that a combined `datetime-local` widget was
 *  awkward — splitting day-vs-time into separate controls is much faster
 *  for the common case ("set 10 AM today"), and lets From/To share a
 *  single Date picker. */
function CalendarEventForm({
  fields,
  values,
  onChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
  startFieldName,
  endFieldName,
}: {
  fields: NonNullable<NonNullable<PanelAction['form']>['fields']>
  values: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
  onSubmit: () => void
  onCancel: () => void
  busy: boolean
  submitLabel: string
  startFieldName: string | null
  endFieldName: string | null
}) {
  const t = useT()
  // Resolve which fields hold start/end datetimes. Prefer the binding's
  // explicit map names; fall back to the first datetime field for start.
  const datetimeFields = fields.filter(
    (f) => f.type === 'datetime' || f.type === 'datetime-local',
  )
  const startField =
    (startFieldName && fields.find((f) => f.name === startFieldName)) ||
    datetimeFields[0] ||
    null
  // Pair the second datetime field as the end whenever one exists, even
  // when the binding doesn't explicitly map `ts_end`. Without this, an
  // unmapped end column falls into `otherFields` and renders as a stray
  // datetime-local picker between Status and Date.
  const endFieldByMap = endFieldName
    ? fields.find((f) => f.name === endFieldName) ?? null
    : null
  const endFieldByPosition =
    datetimeFields[1] && datetimeFields[1].name !== startField?.name
      ? datetimeFields[1]
      : null
  const endField = endFieldByMap ?? endFieldByPosition
  // Split the remaining fields so long-form inputs (textarea = Note etc.)
  // sit BELOW the date/time row instead of pushing it down. Scalar fields
  // (Title/Status/etc.) stay above as the primary identifiers.
  const remaining = fields.filter(
    (f) => f.name !== startField?.name && f.name !== endField?.name,
  )
  const headerFields = remaining.filter((f) => f.type !== 'textarea')
  const longFields = remaining.filter((f) => f.type === 'textarea')

  // Derive (date, fromTime, toTime) from the stringy datetime values.
  const startStr = String(values[startField?.name ?? ''] ?? '')
  const endStr = String(values[endField?.name ?? ''] ?? '')
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(startStr) ?? /^(\d{4}-\d{2}-\d{2})/.exec(endStr)
  const date = dateMatch?.[1] ?? ''
  // Datetime values arrive in two flavours: HTML `datetime-local` writes
  // `YYYY-MM-DDTHH:MM`, but SQLite/Postgres-stored values often serialise
  // with a space separator (`YYYY-MM-DD HH:MM`). Accept either so the
  // form pre-fills correctly when editing existing rows.
  const fromTime = /[T ](\d{2}:\d{2})/.exec(startStr)?.[1] ?? ''
  const toTime = /[T ](\d{2}:\d{2})/.exec(endStr)?.[1] ?? ''

  const writeStart = (newDate: string, newFrom: string) => {
    if (!startField) return
    const next = { ...values }
    next[startField.name] = newDate && newFrom ? `${newDate}T${newFrom}` : newDate
    if (endField) {
      next[endField.name] = newDate && toTime ? `${newDate}T${toTime}` : newDate
    }
    onChange(next)
  }
  const writeFromTime = (newFrom: string) => {
    if (!startField) return
    const next = { ...values }
    next[startField.name] = date && newFrom ? `${date}T${newFrom}` : date
    onChange(next)
  }
  const writeToTime = (newTo: string) => {
    if (!endField) return
    const next = { ...values }
    next[endField.name] = date && newTo ? `${date}T${newTo}` : date
    onChange(next)
  }

  const baseInput =
    'w-full px-2 py-1.5 rounded-sm text-[13.5px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300'

  return (
    <div className="flex flex-col gap-2 mt-1">
      {headerFields.map((f) => (
        <FormField
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(v) => onChange({ ...values, [f.name]: v })}
        />
      ))}
      {startField && (
        <>
          <div>
            <label className="block text-[12px] text-neutral-600 dark:text-neutral-300 mb-1">
              {t('calendar.field.date')}
              {startField.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => writeStart(e.target.value, fromTime)}
              className={baseInput}
            />
          </div>
          <div className={endField ? 'grid grid-cols-2 gap-2' : ''}>
            <div>
              <label className="block text-[12px] text-neutral-600 dark:text-neutral-300 mb-1">
                {t('calendar.field.from')}
                {startField.required && <span className="text-red-500 ml-0.5">*</span>}
              </label>
              <input
                type="time"
                value={fromTime}
                onChange={(e) => writeFromTime(e.target.value)}
                className={baseInput}
              />
            </div>
            {endField && (
              <div>
                <label className="block text-[12px] text-neutral-600 dark:text-neutral-300 mb-1">
                  {t('calendar.field.to')}
                </label>
                <input
                  type="time"
                  value={toTime}
                  onChange={(e) => writeToTime(e.target.value)}
                  className={baseInput}
                />
              </div>
            )}
          </div>
        </>
      )}
      {longFields.map((f) => (
        <FormField
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(v) => onChange({ ...values, [f.name]: v })}
        />
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="h-7 px-3 text-[12px] rounded-sm bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 cursor-pointer"
        >
          {busy ? '…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2 text-[12px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer"
        >
          {t('calendar.cancel')}
        </button>
      </div>
    </div>
  )
}

function CalendarForm({
  fields,
  values,
  onChange,
  onSubmit,
  onCancel,
  busy,
  submitLabel,
}: {
  fields: NonNullable<NonNullable<PanelAction['form']>['fields']>
  values: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
  onSubmit: () => void
  onCancel: () => void
  busy: boolean
  submitLabel: string
}) {
  const t = useT()
  if (fields.length === 0) {
    return <div className="text-[11.5px] text-neutral-400">{t('chart.noData')}</div>
  }
  return (
    <div className="flex flex-col gap-2 mt-1">
      {fields.map((f) => (
        <FormField
          key={f.name}
          field={f}
          value={values[f.name]}
          onChange={(v) => onChange({ ...values, [f.name]: v })}
        />
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="h-7 px-3 text-[12px] rounded-sm bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 cursor-pointer"
        >
          {busy ? '…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2 text-[12px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer"
        >
          {t('calendar.cancel')}
        </button>
      </div>
    </div>
  )
}


function fmtKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isSameDayDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function FormView({
  actions,
  panelId,
  teamId,
  onDone,
  onError,
}: {
  actions: PanelAction[]
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
}) {
  const t = useT()
  const action = actions.find((a) => a.kind === 'create') ?? actions[0]
  const fields = action?.form?.fields ?? []
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])),
  )
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  if (!action || fields.length === 0) {
    return (
      <div className="p-4 text-[13px] text-neutral-400">{t('chart.noData')}</div>
    )
  }

  const submit = async () => {
    if (!panelId || !teamId) return
    setBusy(true)
    setFeedback(null)
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      const r = await executePanelAction(panelId, action.id, teamId, values)
      if (r.ok) {
        setFeedback({ kind: 'ok', text: '✓' })
        setValues(Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])))
        onDone?.()
      } else {
        const msg = r.detail ?? 'failed'
        setFeedback({ kind: 'err', text: msg })
        onError?.(msg)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFeedback({ kind: 'err', text: msg })
      onError?.(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex flex-col gap-3">
        {fields.map((f) => (
          <FormField
            key={f.name}
            field={f}
            value={values[f.name]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
          />
        ))}
        <div className="flex items-center gap-2 mt-1">
          <button
            type="button"
            onClick={submit}
            disabled={busy || !panelId || !teamId}
            className="h-8 px-4 text-[13px] rounded-sm bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {busy ? '…' : actionLabel(action, t) || t('action.submit')}
          </button>
          {feedback && (
            <span
              className={
                feedback.kind === 'ok'
                  ? 'text-[12px] text-emerald-600 dark:text-emerald-400'
                  : 'text-[12px] text-red-600 dark:text-red-400 font-mono break-all'
              }
            >
              {feedback.text}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}


function FormField({
  field,
  value,
  onChange,
}: {
  field: NonNullable<NonNullable<PanelAction['form']>['fields']>[number]
  value: unknown
  onChange: (v: unknown) => void
}) {
  const base =
    'w-full px-2 py-1.5 rounded-sm text-[13.5px] border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-neutral-300'
  const label = (
    <label className="block text-[12px] text-neutral-600 dark:text-neutral-300 mb-1">
      {field.label ?? field.name}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  )
  const str = value === undefined || value === null ? '' : String(value)
  const type = field.type ?? 'text'
  if (type === 'textarea') {
    return (
      <div>
        {label}
        <textarea
          value={str}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className={base}
        />
      </div>
    )
  }
  if (type === 'number') {
    return (
      <div>
        {label}
        <input
          type="number"
          value={str}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className={base}
        />
      </div>
    )
  }
  if (type === 'select') {
    return (
      <div>
        {label}
        <select value={str} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
    )
  }
  if (type === 'date') {
    return (
      <div>
        {label}
        <input
          type="date"
          value={str}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        />
      </div>
    )
  }
  if (type === 'datetime' || type === 'datetime-local') {
    // <input type="datetime-local"> wants `YYYY-MM-DDTHH:MM`. If we receive
    // a stored ISO string with seconds (e.g. `2026-04-26T14:30:00`) trim
    // the tail so the picker treats it as a known value instead of empty.
    const dtStr = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) ? str.slice(0, 16) : str
    return (
      <div>
        {label}
        <input
          type="datetime-local"
          value={dtStr}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        />
      </div>
    )
  }
  if (type === 'time') {
    return (
      <div>
        {label}
        <input
          type="time"
          value={str}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        />
      </div>
    )
  }
  if (type === 'toggle') {
    return (
      <label className="flex items-center gap-2 text-[13px] text-neutral-700 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {field.label ?? field.name}
          {field.required && <span className="text-red-500 ml-0.5">*</span>}
        </span>
      </label>
    )
  }
  return (
    <div>
      {label}
      <input
        type="text"
        value={str}
        onChange={(e) => onChange(e.target.value)}
        className={base}
      />
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
  const t = useT()
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
    <div className="h-full w-full overflow-auto">
    <table className="min-w-full w-max text-[13px]">
      <thead className="bg-neutral-50 dark:bg-neutral-900 sticky top-0">
        <tr>
          {data.columns.map((c) => (
            <th
              key={c}
              className="text-left font-medium text-neutral-500 px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-800 whitespace-nowrap"
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
                    'px-3 py-1.5 border-b border-neutral-100 dark:border-neutral-800 text-neutral-800 dark:text-neutral-100 whitespace-nowrap',
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
                      aria-label={actionLabel(a, t)}
                      title={actionLabel(a, t)}
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
    </div>
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
  /** Stage taxonomy enriched server-side from the team_data table's CHECK
   *  constraint. Canonical source for column order — survives bindings
   *  that don't carry the stage list themselves. */
  stage_taxonomy?: string[]
  /** Actions the binding doesn't carry but the panel type implies (e.g.
   *  kanban move). The server attaches them so drag works without a
   *  re-bind, and the action endpoint resolves the same synthesized IDs. */
  synthesized_actions?: PanelAction[]
}
function KanbanView({
  data,
  onCellClick,
  inlineActions,
  allActions,
  groupBy,
  panelId,
  teamId,
  onDone,
  onError,
}: {
  data: KanbanShape
  onCellClick: ((raw: unknown) => void) | null
  inlineActions?: PanelAction[]
  allActions?: PanelAction[]
  groupBy?: string
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
}) {
  const t = useT()
  const clickable = !!onCellClick
  const [dragCard, setDragCard] = useState<{ raw: Record<string, unknown>; from: string } | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  // Insertion index within the hover column. null = "no specific slot,
  // drop at end". Used to compute sort_order on within-column reorders
  // and cross-column drops onto a specific card position.
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  // Move action resolution chain:
  //   1. `placement: 'drag'` action in the binding (preferred — emitted
  //      by the kanban prompt for new bindings).
  //   2. Inline-placed action targeting group_by — older bindings.
  //   3. Server-synthesized action attached to data.synthesized_actions
  //      when binding carries no move action but source/group_by allow
  //      synthesis (team_data + introspectable table).
  const moveAction = (() => {
    if (!groupBy) return undefined
    const all = allActions ?? []
    const drag = all.find(
      (a) => a.placement === 'drag' && (a.fields ?? []).includes(groupBy),
    )
    if (drag) return drag
    const inline = (inlineActions ?? []).find((a) => (a.fields ?? []).includes(groupBy))
    if (inline) return inline
    const synthesized = (data.synthesized_actions ?? []).find(
      (a) => a.kind === 'update' && (a.fields ?? []).includes(groupBy),
    )
    return synthesized
  })()
  const canDrag = !!(moveAction && panelId && teamId && groupBy)

  const supportsSortOrder = (moveAction?.fields ?? []).includes('sort_order')

  const handleDrop = async (toKey: string, dropIndex: number | null) => {
    if (!dragCard || !moveAction || !canDrag) return
    const sameColumn = dragCard.from === toKey
    if (sameColumn && !supportsSortOrder) {
      // Without a sort_order column we have no way to persist within-column
      // reorders — bail rather than firing a no-op UPDATE that just rewrites
      // the same status. Cross-column drops still work.
      setDragCard(null)
      setHoverKey(null)
      setHoverIndex(null)
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
    if (supportsSortOrder) {
      // Recompute the dropped card's sort_order from neighbours in the
      // target column. Excluding the dragged card from the index list
      // means dragging within the same column doesn't sandwich the card
      // between itself.
      const target = renderGroups.find((g) => g.key === toKey)
      const items = (target?.items ?? []).filter(
        (it) => (it.raw as Record<string, unknown>) !== row,
      )
      const orders = items.map((it) => {
        const so = (it.raw as Record<string, unknown>).sort_order
        return typeof so === 'number' ? so : Number(so) || 0
      })
      const idx =
        dropIndex == null
          ? items.length
          : Math.max(0, Math.min(items.length, dropIndex))
      let newSortOrder: number
      if (items.length === 0) newSortOrder = 1
      else if (idx === 0) newSortOrder = orders[0]! - 1
      else if (idx === items.length) newSortOrder = orders[items.length - 1]! + 1
      else newSortOrder = (orders[idx - 1]! + orders[idx]!) / 2
      values.sort_order = newSortOrder
    }
    try {
      const { executePanelAction } = await import('@/lib/api/panels')
      await executePanelAction(panelId!, moveAction.id, teamId!, values)
      onDone?.()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : String(e))
    } finally {
      setDragCard(null)
      setHoverKey(null)
      setHoverIndex(null)
    }
  }

  // Stage taxonomy resolution:
  //   1. data.stage_taxonomy — server-enriched from the team_data CHECK
  //      constraint. Canonical for any team_data-backed kanban; stays in
  //      sync with the live DB and is independent of binding shape.
  //   2. binding action form options — fallback for sources we can't
  //      introspect (mcp / http) or schemas without a CHECK constraint.
  // Used as the column order so empty stages stay visible even when
  // other stages have rows; without it we fall back to whatever
  // data.groups produced.
  const stageOptions: string[] = (() => {
    if (data.stage_taxonomy && data.stage_taxonomy.length > 0) return data.stage_taxonomy
    if (!groupBy) return []
    const sources = [...(allActions ?? []), ...(inlineActions ?? [])]
    for (const a of sources) {
      const f = a.form?.fields?.find((x) => x.name === groupBy)
      if (f?.options && f.options.length > 0) return f.options
    }
    return []
  })()

  const dataGroups = data.groups ?? []
  type KanbanGroup = KanbanShape['groups'][number]
  const emptyGroup = (key: string): KanbanGroup => ({ key, label: key, items: [] })
  const renderGroups: KanbanGroup[] = (() => {
    if (stageOptions.length === 0) return dataGroups
    const byKey = new Map(dataGroups.map((g) => [g.key, g]))
    const ordered = stageOptions.map((k) => byKey.get(k) ?? emptyGroup(k))
    // Surface any rows whose stage isn't in the declared taxonomy so data
    // never silently disappears — append them after the canonical columns.
    const known = new Set(stageOptions)
    const orphans = dataGroups.filter((g) => !known.has(g.key))
    return [...ordered, ...orphans]
  })()

  if (renderGroups.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-[13px] text-neutral-400">
        {t('kanban.noGroups')}
      </div>
    )
  }

  return (
    <div className="h-full flex gap-2 p-3 overflow-x-auto">
      {renderGroups.map((g) => {
        const isHover = hoverKey === g.key && !!dragCard
        return (
          <div
            key={g.key}
            onDragOver={(e) => {
              if (!canDrag) return
              e.preventDefault()
              // Stop the bubble so the surrounding panel <section> doesn't
              // treat a card drag as a panel-reorder drag-over.
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              if (hoverKey !== g.key) {
                setHoverKey(g.key)
                setHoverIndex(null)
              }
            }}
            onDragLeave={() => setHoverKey((v) => (v === g.key ? null : v))}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void handleDrop(g.key, hoverIndex)
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
                  const showInsertLine =
                    canDrag &&
                    supportsSortOrder &&
                    hoverKey === g.key &&
                    hoverIndex === i &&
                    dragCard?.raw !== raw
                  return (
                    <div key={i}>
                      {showInsertLine && (
                        <div className="h-0.5 -my-0.5 bg-amber-400 rounded-full" />
                      )}
                      <div
                        draggable={canDrag}
                        onDragStart={(e) => {
                          if (!canDrag) return
                          // Card drag must not propagate to the panel
                          // <section>, which would otherwise pick the
                          // card-drag start as a panel-reorder grab.
                          e.stopPropagation()
                          e.dataTransfer.effectAllowed = 'move'
                          setDragCard({ raw, from: g.key })
                        }}
                        onDragOver={(e) => {
                          if (!canDrag || !supportsSortOrder) return
                          e.preventDefault()
                          e.stopPropagation()
                          // Decide whether the drop target lands ABOVE or
                          // BELOW this card based on the cursor's vertical
                          // position relative to the card's midpoint.
                          const rect = (
                            e.currentTarget as HTMLElement
                          ).getBoundingClientRect()
                          const above = e.clientY < rect.top + rect.height / 2
                          const idx = above ? i : i + 1
                          if (hoverKey !== g.key) setHoverKey(g.key)
                          if (hoverIndex !== idx) setHoverIndex(idx)
                        }}
                        onDragEnd={(e) => {
                          e.stopPropagation()
                          setDragCard(null)
                          setHoverKey(null)
                          setHoverIndex(null)
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
  /** Set when the binding declared `series_by` — stacked bar/area and the
   *  heatmap variant read this. Single-series charts leave it unset and fall
   *  back to `x`/`y`. */
  matrix?: {
    rows: string[]
    cols: string[]
    values: number[][]
  }
}
function ChartView({ data, props }: { data: ChartShape; props?: Record<string, unknown> }) {
  const t = useT()
  const variant =
    (props?.variant as
      | 'bar'
      | 'line'
      | 'area'
      | 'pie'
      | 'heatmap'
      | undefined) ?? 'bar'
  const stacked = Boolean(props?.stacked)
  const multiSeries = (data.series?.length ?? 0) > 1
  const layout = props?.layout === 'horizontal' ? 'horizontal' : 'vertical'
  const goal =
    typeof props?.goal_line === 'number' && Number.isFinite(props.goal_line as number)
      ? (props.goal_line as number)
      : null

  // Optional time-range tab strip. Only rendered when the panel declares
  // `props.time_ranges`. Slicing happens client-side: SQL returns the largest
  // window (e.g. 90 days), the user picks 7 / 30 / 90 and we tail the array.
  const ranges = Array.isArray(props?.time_ranges)
    ? (props.time_ranges as unknown[])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
    : []
  const defaultRange =
    typeof props?.default_range === 'number' && ranges.includes(props.default_range as number)
      ? (props.default_range as number)
      : (ranges[ranges.length - 1] ?? null)
  const [range, setRange] = useState<number | null>(defaultRange)

  const fullXs = data.x ?? []
  const fullYs = data.y ?? []
  // Auto-trim ISO timestamps to date-only for axis/tooltip readability.
  // Catches both ISO (`YYYY-MM-DDTHH:MM:SS…`, SQLite/JSON) and Postgres
  // (`YYYY-MM-DD HH:MM:SS+TZ`, returned by date_trunc/timestamptz).
  const trimX = (v: string) =>
    /^\d{4}-\d{2}-\d{2}[T ]/.test(v) ? v.slice(0, 10) : v
  const trimmedXs = fullXs.map((v) => trimX(String(v)))

  // When the panel uses time_ranges and all x values look like calendar
  // dates, build a complete daily series ending today so days with no rows
  // show as 0 instead of being skipped. Otherwise fall back to a tail-slice
  // of whatever rows the binding returned (works for non-date charts too).
  const isDateAxis =
    ranges.length > 0 && trimmedXs.length > 0 && trimmedXs.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))
  let rows: { x: string; y: number }[]
  if (isDateAxis && range != null) {
    const valueByDay = new Map<string, number>()
    trimmedXs.forEach((d, i) => {
      const y = Number(fullYs[i])
      valueByDay.set(d, Number.isFinite(y) ? y : 0)
    })
    // Detect a cumulative/monotone series: data points are non-decreasing
    // and start above zero. For those we carry the last known value forward
    // into "no row" days (gaps and tail) instead of dropping to 0 — that
    // way "총 가입자 12명" stays at 12 after the last signup day, not 0.
    // Default for additive series (daily counts, events) is still zero-fill.
    const numericYs = fullYs
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
    const isCumulative =
      numericYs.length >= 2 &&
      numericYs.every((v, i) => i === 0 || v >= (numericYs[i - 1] as number)) &&
      (numericYs[0] as number) >= 0 &&
      (numericYs[numericYs.length - 1] as number) > 0
    const days: { x: string; y: number }[] = []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    let lastKnown = 0
    for (let offset = range - 1; offset >= 0; offset -= 1) {
      const d = new Date(today)
      d.setDate(d.getDate() - offset)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const direct = valueByDay.get(key)
      if (direct !== undefined) {
        lastKnown = direct
        days.push({ x: key, y: direct })
      } else {
        days.push({ x: key, y: isCumulative ? lastKnown : 0 })
      }
    }
    rows = days
  } else {
    const xs = range != null ? trimmedXs.slice(-range) : trimmedXs
    const ys = range != null ? fullYs.slice(-range) : fullYs
    rows = xs.map((x, i) => ({ x, y: ys[i] ?? 0 }))
  }
  const tickCount = rows.length > 8 ? 5 : Math.max(2, rows.length)

  const tabs = ranges.length > 0 ? (
    <div className="px-3 pt-2 flex items-center justify-end gap-1">
      {ranges.map((n) => {
        const active = n === range
        return (
          <button
            key={n}
            type="button"
            onClick={() => setRange(n)}
            className={
              active
                ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {n}d
          </button>
        )
      })}
    </div>
  ) : null

  // Heatmap routes off the matrix payload, not the flat x/y. Routing it
  // before the generic "no data" guard means a momentary empty refresh
  // doesn't flash the bare "(no data)" text — HeatmapView renders its own
  // empty state when matrix is absent.
  if (variant === 'heatmap') {
    return <HeatmapView matrix={data.matrix ?? null} timeTabs={tabs} />
  }

  if (fullXs.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {tabs}
        <div className="p-4 text-[13px] text-neutral-400">{t('chart.noData')}</div>
      </div>
    )
  }

  const sharedAxisProps = {
    stroke: 'currentColor',
    tick: { fontSize: 11, fill: 'currentColor' },
    tickLine: false,
    axisLine: { stroke: 'currentColor', strokeOpacity: 0.2 },
  } as const

  if (variant === 'line' || variant === 'area') {
    const Chart = variant === 'area' ? AreaChart : LineChart
    return (
      <div className="h-full flex flex-col">
        {tabs}
        <div className="flex-1 min-h-0 w-full p-3 text-neutral-400 dark:text-neutral-500">
          <ResponsiveContainer width="100%" height="100%">
            <Chart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
              <XAxis dataKey="x" {...sharedAxisProps} interval="preserveStartEnd" minTickGap={20} tickCount={tickCount} />
              <YAxis {...sharedAxisProps} width={28} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }} isAnimationActive={false} />
              {variant === 'area' ? (
                <Area
                  type="monotone"
                  dataKey="y"
                  stroke="rgb(38 38 38)"
                  strokeWidth={1.5}
                  fill="rgb(38 38 38)"
                  fillOpacity={0.12}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  type="monotone"
                  dataKey="y"
                  stroke="rgb(38 38 38)"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={false}
                />
              )}
              {goal != null && (
                <ReferenceLine y={goal} stroke="rgb(16 185 129)" strokeDasharray="3 3" strokeWidth={1} />
              )}
            </Chart>
          </ResponsiveContainer>
        </div>
      </div>
    )
  }

  if (variant === 'pie') {
    return <PieView rows={rows} timeTabs={tabs} />
  }

  // Stacked path: when the binding produced multiple series (via series_by)
  // OR the panel explicitly declared `stacked`, render a stacked bar/area
  // instead of the single-series bar.
  if ((stacked || multiSeries) && (variant === 'bar' || variant === 'area')) {
    return (
      <StackedView
        x={data.x ?? []}
        series={data.series ?? []}
        variant={variant}
        layout={layout}
        timeTabs={tabs}
      />
    )
  }

  // bar (default).
  return (
    <BarView
      rows={rows}
      props={props}
      timeTabs={tabs}
      goal={goal}
      otherLabel={t('chart.other')}
      tCount={t('chart.count')}
      tShare={t('chart.share')}
    />
  )
}

/** Bar / Column with horizontal-or-vertical layout, capped bar thickness,
 *  scrolling on overflow, dataMax-pinned axis, "Other"-collapse beyond 9
 *  categories, and a top-right "개수 / 비중" toggle (default 개수). */
function BarView({
  rows,
  props,
  timeTabs,
  goal,
  otherLabel,
  tCount,
  tShare,
}: {
  rows: { x: string; y: number }[]
  props?: Record<string, unknown>
  timeTabs: React.ReactElement | null
  goal: number | null
  otherLabel: string
  tCount: string
  tShare: string
}) {
  const horizontal = props?.layout === 'horizontal'
  const [mode, setMode] = useState<'count' | 'pct'>('count')
  const barRows = collapseToOther(rows, 9, otherLabel)
  const total = barRows.reduce((s, r) => s + (Number.isFinite(r.y) ? r.y : 0), 0)
  const formatValue = (v: number) =>
    mode === 'pct'
      ? total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0%'
      : Intl.NumberFormat().format(v)
  const ROW_PX = 56
  const COL_PX = 64
  const MAX_BAR = 40
  const lockedHeight = horizontal ? Math.max(barRows.length * ROW_PX, ROW_PX * 2) : null
  const lockedWidth = !horizontal ? Math.max(barRows.length * COL_PX, COL_PX * 3) : null
  const sharedAxisProps = {
    stroke: 'currentColor',
    tick: { fontSize: 11, fill: 'currentColor' },
    tickLine: false,
    axisLine: { stroke: 'currentColor', strokeOpacity: 0.2 },
  } as const
  const headerTabs = (
    <div className="px-3 pt-2 flex items-center justify-end gap-1">
      {([
        { id: 'count', label: tCount },
        { id: 'pct', label: tShare },
      ] as const).map(({ id, label }) => {
        const active = mode === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={
              active
                ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
  return (
    <div className="h-full flex flex-col">
      {timeTabs}
      {headerTabs}
      <div className={
        horizontal
          ? 'flex-1 min-h-0 w-full p-3 pt-1 text-neutral-400 dark:text-neutral-500 overflow-y-auto'
          : 'flex-1 min-h-0 w-full p-3 pt-1 text-neutral-400 dark:text-neutral-500 overflow-x-auto'
      }>
        <div style={
          lockedHeight
            ? { height: `${lockedHeight}px`, width: '100%' }
            : lockedWidth
              ? { width: `${lockedWidth}px`, height: '100%', minWidth: '100%' }
              : { height: '100%', width: '100%' }
        }>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={barRows}
              layout={horizontal ? 'vertical' : 'horizontal'}
              margin={{ top: 8, right: horizontal ? 24 : 12, bottom: 4, left: horizontal ? 12 : 4 }}
            >
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={horizontal} horizontal={!horizontal} />
              {horizontal ? (
                <>
                  <XAxis type="number" domain={[0, 'dataMax']} tickFormatter={formatValue} {...sharedAxisProps} />
                  <YAxis type="category" dataKey="x" {...sharedAxisProps} width={80} interval={0} />
                </>
              ) : (
                <>
                  <XAxis dataKey="x" {...sharedAxisProps} interval={0} />
                  <YAxis domain={[0, 'dataMax']} tickFormatter={formatValue} {...sharedAxisProps} width={mode === 'pct' ? 40 : 28} />
                </>
              )}
              <Tooltip
                content={<ChartTooltip valueFormatter={formatValue} />}
                cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                isAnimationActive={false}
              />
              <Bar dataKey="y" fill="rgb(38 38 38)" radius={horizontal ? [0, 2, 2, 0] : [2, 2, 0, 0]} maxBarSize={MAX_BAR} isAnimationActive={false} />
              {goal != null && (
                <ReferenceLine y={goal} stroke="rgb(16 185 129)" strokeDasharray="3 3" strokeWidth={1} />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

// Distinct, accessible-ish palette for pie/donut slices. Cycled per slice;
// pick contrasting hues so adjacent slices stay legible. 12 entries cover
// most realistic category counts before wrap.
const PIE_PALETTE = [
  '#2563eb', // blue-600
  '#f97316', // orange-500
  '#16a34a', // green-600
  '#db2777', // pink-600
  '#a855f7', // purple-500
  '#eab308', // yellow-500
  '#0ea5e9', // sky-500
  '#dc2626', // red-600
  '#14b8a6', // teal-500
  '#8b5cf6', // violet-500
  '#84cc16', // lime-500
  '#64748b', // slate-500
] as const

/** Pie chart with a top-right "개수 / 비중" toggle controlling the legend
 *  (and tooltip) format. Slices beyond the palette get collapsed to "기타". */
/** Multi-series stacked chart (bar or area). The data model already carried
 *  a `series[]` field; we just had no view consuming more than the first
 *  series until now. Series share an x axis; categorical palette is the
 *  same neutral ramp used elsewhere in the dashboard. */
function StackedView({
  x,
  series,
  variant,
  layout,
  timeTabs,
}: {
  x: string[]
  series: { name: string; data: number[] }[]
  variant: 'bar' | 'area'
  layout: 'horizontal' | 'vertical'
  timeTabs: React.ReactElement | null
}) {
  const t = useT()
  if (x.length === 0 || series.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {timeTabs}
        <div className="p-4 text-[13px] text-neutral-400">{t('chart.noData')}</div>
      </div>
    )
  }
  const data = x.map((xKey, i) => {
    const row: Record<string, string | number> = { x: xKey }
    for (const s of series) row[s.name] = s.data[i] ?? 0
    return row
  })
  const palette = [
    'rgb(38 38 38)',
    'rgb(115 115 115)',
    'rgb(163 163 163)',
    'rgb(212 212 212)',
    'rgb(82 82 82)',
    'rgb(140 140 140)',
    'rgb(190 190 190)',
    'rgb(64 64 64)',
  ]
  const sharedAxisProps = {
    stroke: 'currentColor',
    tick: { fontSize: 11, fill: 'currentColor' },
    tickLine: false,
    axisLine: { stroke: 'currentColor', strokeOpacity: 0.2 },
  } as const
  return (
    <div className="h-full flex flex-col">
      {timeTabs}
      <div className="flex-1 min-h-0 w-full p-3 text-neutral-400 dark:text-neutral-500">
        <ResponsiveContainer width="100%" height="100%">
          {variant === 'area' ? (
            <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
              <XAxis dataKey="x" {...sharedAxisProps} interval="preserveStartEnd" minTickGap={20} />
              <YAxis {...sharedAxisProps} width={28} />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'currentColor', strokeOpacity: 0.2 }} isAnimationActive={false} />
              {series.map((s, i) => (
                <Area
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  stackId="a"
                  stroke={palette[i % palette.length]}
                  fill={palette[i % palette.length]}
                  fillOpacity={0.5}
                  strokeWidth={1}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          ) : (
            <BarChart
              data={data}
              layout={layout === 'horizontal' ? 'vertical' : 'horizontal'}
              margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
            >
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.15} vertical={false} />
              {layout === 'horizontal' ? (
                <>
                  <XAxis type="number" {...sharedAxisProps} />
                  <YAxis dataKey="x" type="category" {...sharedAxisProps} width={80} />
                </>
              ) : (
                <>
                  <XAxis dataKey="x" {...sharedAxisProps} interval={0} />
                  <YAxis {...sharedAxisProps} width={28} />
                </>
              )}
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'currentColor', fillOpacity: 0.05 }} isAnimationActive={false} />
              {series.map((s, i) => (
                <Bar
                  key={s.name}
                  dataKey={s.name}
                  stackId="a"
                  fill={palette[i % palette.length]}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/** Categorical 2D density. Rows = series_by, cols = group_by, each cell
 *  shaded by its value normalised to the matrix max.
 *
 *  Layout decisions tied to the user's complaint that 7×24 looked like
 *  garbled noise:
 *  - Row/col labels are reordered semantically when we recognise them
 *    (Mon..Sun for day names, ascending for numerics) — the binder sorts
 *    by raw bucket key which is rarely the order a human expects.
 *  - In dense matrices (>12 cols or >10 rows) the in-cell numeric is
 *    suppressed; colour does the talking and the exact value still lives
 *    in the hover tooltip. Otherwise small cells truncate the number into
 *    "1.." nonsense.
 *  - Column headers thin out when overcrowded (every Nth label) so the
 *    header row doesn't collide with itself. */
function HeatmapView({
  matrix,
  timeTabs,
}: {
  matrix: { rows: string[]; cols: string[]; values: number[][] } | null
  timeTabs: React.ReactElement | null
}) {
  const t = useT()
  const ordered = useMemo(() => orderHeatmap(matrix), [matrix])
  if (!ordered) {
    return (
      <div className="h-full flex flex-col">
        {timeTabs}
        <div className="p-4 text-[13px] text-neutral-400">{t('chart.noData')}</div>
      </div>
    )
  }
  const { rows, cols, values } = ordered
  let max = 0
  for (const row of values) for (const v of row) if (v > max) max = v
  const safeMax = max > 0 ? max : 1
  const colStride = cols.length > 18 ? 3 : cols.length > 12 ? 2 : 1
  const formatValue = (v: number): string => {
    if (v >= 10000) return `${(v / 1000).toFixed(0)}k`
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
    return String(v)
  }
  // Square cells, sized to fit comfortably without dwarfing the panel.
  // Tiered down as col/row count grows so dense grids still fit standard
  // panel widths.
  const CELL =
    cols.length <= 8 && rows.length <= 8
      ? 48
      : cols.length <= 14
        ? 36
        : 30
  return (
    <div className="h-full flex flex-col">
      {timeTabs}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        <div
          className="grid gap-[2px] w-fit"
          style={{
            gridTemplateColumns: `auto repeat(${cols.length}, ${CELL}px)`,
          }}
        >
          <div />
          {cols.map((c, ci) => (
            <div
              key={c}
              className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium tracking-wide text-center pb-1 truncate"
              style={{ width: CELL }}
            >
              {ci % colStride === 0 ? c : ''}
            </div>
          ))}
          {rows.map((rowLabel, ri) => (
            <Fragment key={rowLabel}>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium tracking-wide pr-2 self-center text-right tabular-nums whitespace-nowrap">
                {rowLabel}
              </div>
              {cols.map((colLabel, ci) => {
                const v = values[ri]?.[ci] ?? 0
                const intensity = v / safeMax
                const bg =
                  intensity > 0
                    ? `rgba(38,38,38,${(0.08 + intensity * 0.82).toFixed(3)})`
                    : 'rgba(0,0,0,0.04)'
                return (
                  <div
                    key={colLabel}
                    title={`${rowLabel} × ${colLabel}: ${formatValue(v)}`}
                    className="rounded-[2px] flex items-center justify-center text-[9.5px] tabular-nums select-none cursor-default group/cell relative"
                    style={{
                      background: bg,
                      width: CELL,
                      height: CELL,
                    }}
                  >
                    <span
                      className="opacity-0 group-hover/cell:opacity-100 transition-opacity"
                      style={{
                        color: intensity > 0.55 ? 'white' : 'rgb(82 82 82)',
                      }}
                    >
                      {v > 0 ? formatValue(v) : ''}
                    </span>
                  </div>
                )
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_ORDER_FULL = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]
const DAY_ORDER_KO = ['월', '화', '수', '목', '금', '토', '일']

function orderHeatmap(
  m: { rows: string[]; cols: string[]; values: number[][] } | null,
): { rows: string[]; cols: string[]; values: number[][] } | null {
  if (!m || m.rows.length === 0 || m.cols.length === 0) return null
  const rowIdx = sortedIndex(m.rows)
  const colIdx = sortedIndex(m.cols)
  const rows = rowIdx.map((i) => m.rows[i] ?? '')
  const cols = colIdx.map((i) => m.cols[i] ?? '')
  const values = rowIdx.map((ri) => colIdx.map((ci) => m.values[ri]?.[ci] ?? 0))
  return { rows, cols, values }
}

/** Returns indices into `labels[]` reordered semantically. Day-of-week names
 *  (Mon/Monday/월) → calendar order; pure numerics → ascending; otherwise
 *  the original order is preserved. Anything not recognised falls to the
 *  end so a single misspelled label doesn't scramble the rest. */
function sortedIndex(labels: string[]): number[] {
  const idx = labels.map((_, i) => i)
  const dayOrderOf = (s: string): number => {
    const t = s.trim()
    let i = DAY_ORDER.indexOf(t)
    if (i >= 0) return i
    i = DAY_ORDER_FULL.indexOf(t)
    if (i >= 0) return i
    i = DAY_ORDER_KO.indexOf(t)
    return i
  }
  const allDays = labels.every((l) => dayOrderOf(l) >= 0)
  if (allDays) {
    return idx.sort((a, b) => dayOrderOf(labels[a] ?? '') - dayOrderOf(labels[b] ?? ''))
  }
  const allNumeric = labels.every((l) => /^-?\d+(\.\d+)?$/.test(l.trim()))
  if (allNumeric) {
    return idx.sort((a, b) => Number(labels[a]) - Number(labels[b]))
  }
  // ISO date YYYY-MM-DD lex-sorts the same as chronological — handy for
  // line-chart-derived heatmaps (week × day, etc.).
  const allIsoDate = labels.every((l) => /^\d{4}-\d{2}-\d{2}/.test(l.trim()))
  if (allIsoDate) {
    return idx.sort((a, b) => (labels[a] ?? '').localeCompare(labels[b] ?? ''))
  }
  return idx
}

function PieView({
  rows,
  timeTabs,
}: {
  rows: { x: string; y: number }[]
  timeTabs: React.ReactElement | null
}) {
  const t = useT()
  const [mode, setMode] = useState<'count' | 'pct'>('pct')
  const pieRows = collapseToOther(rows, 9, t('chart.other'))
  const total = pieRows.reduce((s, r) => s + (Number.isFinite(r.y) ? r.y : 0), 0)
  const formatValue = (v: number) =>
    mode === 'pct'
      ? total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0%'
      : Intl.NumberFormat().format(v)
  const headerTabs = (
    <div className="px-3 pt-2 flex items-center justify-end gap-1">
      {([
        { id: 'count', label: t('chart.count') },
        { id: 'pct', label: t('chart.share') },
      ] as const).map(({ id, label }) => {
        const active = mode === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={
              active
                ? 'px-2 py-0.5 rounded-sm text-[11.5px] font-medium bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 cursor-pointer'
                : 'px-2 py-0.5 rounded-sm text-[11.5px] text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 cursor-pointer'
            }
          >
            {label}
          </button>
        )
      })}
    </div>
  )
  return (
    <div className="h-full flex flex-col">
      {timeTabs}
      {headerTabs}
      <div className="flex-1 min-h-0 w-full grid grid-cols-[1fr_auto] gap-2 p-3 pt-1 text-neutral-400 dark:text-neutral-500">
        <div className="min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
              <Tooltip
                content={<ChartTooltip valueFormatter={formatValue} />}
                isAnimationActive={false}
              />
              <Pie
                data={pieRows}
                dataKey="y"
                nameKey="x"
                innerRadius="50%"
                outerRadius="85%"
                paddingAngle={0}
                stroke="none"
                isAnimationActive={false}
              >
                {pieRows.map((_, i) => (
                  <Cell
                    key={i}
                    fill={PIE_PALETTE[i % PIE_PALETTE.length]}
                    stroke="none"
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        <PieLegend rows={pieRows} format={formatValue} />
      </div>
    </div>
  )
}

/** Collapse rows beyond the palette size into a single "Other" slice so the
 *  pie keeps distinct colors. Sorts by value descending first so the biggest
 *  N-1 slices stay individual; the rest get summed. */
function collapseToOther(
  rows: { x: string; y: number }[],
  maxSlices: number,
  otherLabel = 'Other',
): { x: string; y: number }[] {
  if (rows.length <= maxSlices) return rows
  const sorted = [...rows].sort((a, b) => b.y - a.y)
  const head = sorted.slice(0, maxSlices - 1)
  const tail = sorted.slice(maxSlices - 1)
  const otherSum = tail.reduce((s, r) => s + (Number.isFinite(r.y) ? r.y : 0), 0)
  return [...head, { x: otherLabel, y: otherSum }]
}

function PieLegend({
  rows,
  format,
}: {
  rows: { x: string; y: number }[]
  format?: (v: number) => string
}) {
  if (rows.length === 0) return null
  const fmt = format ?? ((v: number) => Intl.NumberFormat().format(v))
  return (
    <div className="self-end max-h-full min-w-[110px] max-w-[200px] overflow-y-auto pr-1">
      <ul className="space-y-1 text-[11.5px] leading-tight text-neutral-600 dark:text-neutral-300">
        {rows.map((r, i) => (
          <li key={`${r.x}-${i}`} className="flex items-center gap-1.5 min-w-0">
            <span
              className="shrink-0 inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: PIE_PALETTE[i % PIE_PALETTE.length] }}
            />
            <span className="truncate flex-1">{r.x}</span>
            <span className="shrink-0 text-neutral-400 font-mono">{fmt(r.y)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean
  payload?: { value?: number | string; name?: string; payload?: { x?: unknown } }[]
  label?: string | number
  valueFormatter?: (v: number) => string
}) {
  if (!active || !payload || payload.length === 0) return null
  const entry = payload[0]
  const v = entry?.value
  const heading =
    (label !== undefined && label !== '' ? String(label) : null) ??
    (entry?.payload && typeof entry.payload.x !== 'undefined' ? String(entry.payload.x) : null) ??
    (entry?.name ? String(entry.name) : '')
  const formatted =
    typeof v === 'number'
      ? valueFormatter
        ? valueFormatter(v)
        : Intl.NumberFormat().format(v)
      : String(v ?? '')
  return (
    <div className="rounded-sm border border-neutral-200 dark:border-neutral-700 bg-white/95 dark:bg-neutral-900/95 px-2 py-1 text-[11.5px] font-mono text-neutral-700 dark:text-neutral-200 shadow-sm">
      {heading && <div className="text-neutral-400">{heading}</div>}
      <div className="text-neutral-900 dark:text-neutral-50">{formatted}</div>
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

function DetailModal({
  raw,
  actions,
  panelId,
  teamId,
  onDone,
  onError,
  onClose,
}: {
  raw: unknown
  actions?: PanelAction[]
  panelId?: string
  teamId?: string
  onDone?: () => void
  onError?: (msg: string) => void
  onClose: () => void
}) {
  const t = useT()
  const entries = toEntries(raw)
  const acts = actions ?? []
  const updateAction = acts.find(
    (a) => a.kind === 'update' && (a.form?.fields?.length ?? 0) > 0,
  )
  const deleteAction = acts.find((a) => a.kind === 'delete')
  const canExecute = !!(panelId && teamId)
  const [editing, setEditing] = useState(false)

  // Pre-fill the edit form with the row's primitive fields. Skip nested
  // objects/arrays — the form has no widget for them and they aren't in
  // the synthesized form schema either.
  const initialValues: Record<string, unknown> = (() => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        out[k] = v
      }
    }
    return out
  })()

  if (editing && updateAction && canExecute) {
    return (
      <ActionFormModal
        panelId={panelId!}
        teamId={teamId!}
        action={updateAction}
        initialValues={initialValues}
        onClose={() => setEditing(false)}
        onSuccess={() => {
          setEditing(false)
          onDone?.()
        }}
      />
    )
  }

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
        {canExecute && (updateAction || deleteAction) && (
          <div className="px-4 py-2.5 border-t border-neutral-200 dark:border-neutral-800 flex items-center justify-end gap-2">
            {deleteAction && (
              <button
                type="button"
                onClick={() => {
                  void runConfirmAction({
                    panelId: panelId!,
                    teamId: teamId!,
                    action: deleteAction,
                    values: initialValues,
                    t,
                    onSuccess: () => {
                      onClose()
                      onDone?.()
                    },
                    onError: (msg) => onError?.(msg),
                  })
                }}
                className="px-3 py-1.5 rounded-sm text-[13px] text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 cursor-pointer"
              >
                {t('panel.detail.delete')}
              </button>
            )}
            {updateAction && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 rounded-sm text-[13px] bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 hover:opacity-90 cursor-pointer"
              >
                {t('panel.detail.edit')}
              </button>
            )}
          </div>
        )}
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
